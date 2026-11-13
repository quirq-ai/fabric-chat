// The app's connection to Fabric, through the Gateway service every 2.5 peer runs.
//
// The app talks to one peer only: the peer of the person's own company. For a read, that peer runs
// the chaincode and answers. For a write, the same peer does the rest of the work itself:
//   1. endorse  it runs the chaincode, and asks other companies' peers to run it too and sign the result
//   2. submit   the app signs the endorsed transaction, and the peer hands it to the orderers
//   3. commit   the orderers put it in a block; every peer checks the block and applies it
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import { connect, hash, signers, GatewayError, StatusCode, type Contract, type Gateway, type Network, type Status, type SubmittedTransaction } from "@hyperledger/fabric-gateway";
import { gateway as gatewayProtos } from "@hyperledger/fabric-protos";
import { ChatError, file, network, type OrgConfig } from "./config";
import { decodeEnvelope } from "./decode";
import type { Identity, Party } from "./people";

const clients = new Map<string, grpc.Client>();
const gateways = new Map<string, Gateway>();

/** One TLS connection per company, to that company's peer. */
function clientOf(org: OrgConfig): grpc.Client {
  let client = clients.get(org.code);
  if (!client) {
    // The peer is reached through a port on this machine, so its certificate is checked against its real name.
    client = new grpc.Client(org.peer.endpoint, grpc.credentials.createSsl(readFileSync(file(org.peer.tlsCa))), {
      "grpc.ssl_target_name_override": org.peer.name,
    });
    clients.set(org.code, client);
  }
  return client;
}

/** A gateway connection that signs as one identity. Many share one TLS connection. */
function gatewayOf(identity: Identity): Gateway {
  let gateway = gateways.get(identity.id);
  if (!gateway) {
    gateway = connect({
      client: clientOf(identity.org),
      identity: { mspId: identity.org.msp, credentials: Buffer.from(identity.certPem) },
      signer: signers.newPrivateKeySigner(identity.key),
      hash: hash.sha256,
      evaluateOptions: () => ({ deadline: Date.now() + 8_000 }),
      endorseOptions: () => ({ deadline: Date.now() + 20_000 }),
      submitOptions: () => ({ deadline: Date.now() + 8_000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 30_000 }),
    });
    gateways.set(identity.id, gateway);
  }
  return gateway;
}

export function channelOf(identity: Identity, channel: string): Network {
  return gatewayOf(identity).getNetwork(channel);
}

function contractOf(identity: Identity, channel: string, chaincode = network().chaincode.name): Contract {
  return channelOf(identity, channel).getContract(chaincode);
}

const statusOf: Record<string, number> = {
  CHAT_BAD_INPUT: 400,
  CHAT_BAD_SCOPE: 400,
  CHAT_NO_IDENTITY: 401,
  CHAT_NOT_JOINED: 403,
  CHAT_NOT_MEMBER: 403,
  CHAT_NOT_AUTHOR: 403,
  CHAT_WRONG_SCOPE: 403,
  CHAT_NOT_FOUND: 404,
  CHAT_UNKNOWN_USER: 404,
  CHAT_NAME_TAKEN: 409,
  CHAT_NO_CHANGE: 409,
  CHAT_GONE: 410,
};

/** What to say about a record that this server holds in an older version than the ledger records. */
export const OLDER_COPY =
  "This server holds an older version of this than the ledger records. The server was restored from a backup made before the last change, and that change was kept here only, so it is lost. This can still be read as it was, but no longer changed.";

/** Turns whatever Fabric threw into an error with a code and plain words. */
export function translate(err: unknown): ChatError {
  if (err instanceof ChatError) return err;
  if (err instanceof GatewayError) {
    const texts = [...err.details.map((d) => d.message), err.message];
    // The chaincode's own refusals start with a code, for example CHAT_NOT_MEMBER.
    for (const text of texts) {
      const match = /(CHAT_[A-Z_]+): ([^\n]*)/.exec(text);
      if (!match) continue;
      // A record that a company's own store holds in an older version than the ledger records. It
      // is what a restore leaves of something that was changed after the backup: the change was
      // kept on that server only. Fabric then refuses to hand out the older version by its key
      // ("private data matching public hash version is not available ... TxNum: 0}"), and the
      // chaincode passes on the end of that sentence.
      if (match[1] === "CHAT_NOT_HELD" && /: \d+\}$/.test(match[2].trim())) {
        return new ChatError(409, "CHAT_OLDER_COPY", OLDER_COPY);
      }
      return new ChatError(statusOf[match[1]] ?? 500, match[1], match[2].trim());
    }
    const all = texts.join(" | ");
    // The peer answered, but the orderers it handed the transaction to could not take it.
    if (/no raft leader|orderer|ordering service/i.test(all)) {
      return new ChatError(503, "LEDGER_NO_ORDERERS", "The orderers could not put this into a block. Too few of this channel's orderers are running for them to agree on an order.");
    }
    if (err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.DEADLINE_EXCEEDED) {
      return new ChatError(503, "LEDGER_DOWN", "Your company's peer did not answer in time. Check that the network is running.");
    }
    if (/endorse|endorsement/i.test(all)) {
      // Each detail names a peer that was asked and did not sign.
      const silent = [...new Set(err.details.map((d) => network().orgs.find((o) => o.msp === d.mspId)?.name).filter((name) => !!name))];
      const who = silent.length ? ` No answer from the peer of ${silent.join(" or ")}.` : "";
      return new ChatError(503, "LEDGER_NO_ENDORSERS", `Not enough companies' peers could endorse this.${who}`);
    }
    return new ChatError(502, "LEDGER_ERROR", all.slice(0, 400));
  }
  const text = err instanceof Error ? err.message : String(err);
  if (/UNAVAILABLE|ECONNREFUSED|No connection established/i.test(text)) {
    return new ChatError(503, "LEDGER_DOWN", "Your company's peer cannot be reached. Check that the network is running.");
  }
  return new ChatError(500, "LEDGER_ERROR", text.slice(0, 400));
}

function parse<T>(bytes: Uint8Array): T {
  const text = Buffer.from(bytes).toString("utf8");
  return (text ? JSON.parse(text) : null) as T;
}

/** Asks the identity's own peer to run a chaincode function and return the answer. Nothing is written. */
export async function evaluate<T>(identity: Identity, channel: string, fn: string, args: string[] = [], chaincode?: string): Promise<T> {
  try {
    return parse<T>(await contractOf(identity, channel, chaincode).evaluate(fn, { arguments: args }));
  } catch (err) {
    throw translate(err);
  }
}

/** The same, for system chaincode that answers in protobuf rather than JSON. */
export async function evaluateRaw(identity: Identity, channel: string, chaincode: string, fn: string, args: string[]): Promise<Uint8Array> {
  try {
    return await contractOf(identity, channel, chaincode).evaluate(fn, { arguments: args });
  } catch (err) {
    throw translate(err);
  }
}

/** What happened to a transaction on its way into the ledger. */
export interface Receipt {
  txId: string;
  block: number;
  validation: string;
  /** The peers that ran the chaincode and signed the result. */
  endorsers: Party[];
  /** Milliseconds spent in each of the three steps. */
  endorseMs: number;
  orderMs: number;
  commitMs: number;
  /** More than 1 when an earlier try lost a race with another transaction and was sent again. */
  attempts: number;
  /** More than 1 when the orderers did not take the transaction at first and it was offered to them again. */
  offers: number;
}

export interface SubmitOptions {
  args: string[];
  /** Details that must not be written to the ledger. The endorsing peers see them; the block does not. */
  transient?: Record<string, string>;
  /** The companies (MSP IDs) whose peers must endorse. Left out, the gateway works it out from the endorsement policy. */
  endorsingOrgs?: string[];
}

const validationName = (code: number) => Object.entries(StatusCode).find(([, value]) => value === code)?.[0] ?? String(code);

/**
 * Two transactions that read the same record and land in the same block cannot both win: the
 * second is marked MVCC_READ_CONFLICT and changes nothing. The cure is to run it again.
 */
const retryable = new Set(["MVCC_READ_CONFLICT", "PHANTOM_READ_CONFLICT"]);

/**
 * An endorsed transaction that the orderers did not take is offered to them again, unchanged, for
 * up to this long. It keeps its ID and a ledger takes an ID once, so offering it again cannot write
 * it twice. Choosing a leader takes the orderers up to ten seconds, and an orderer that still
 * follows the one that has gone holds a transaction for seven before it gives it back. When two
 * orderers stop and start within seconds of each other, those waits add up.
 */
const offerFor = 30_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A channel has one orderer for each company on it. */
const orderersOf = (channel: string) => network().workspaces.find((workspace) => workspace.channel === channel)?.orgs.length ?? 0;

/** Why the orderers did not take a transaction, for the server's own log. */
function refusal(err: unknown): string {
  if (!(err instanceof GatewayError)) return err instanceof Error ? err.message : String(err);
  const each = err.details.map((detail) => `${detail.address}: ${detail.message}`).join("; ");
  return `${grpc.status[err.code] ?? err.code}: ${err.cause?.details || err.message}${each ? ` [${each}]` : ""}`.slice(0, 700);
}

/** An orderer that is named in a workspace's rules but is not on its channel: its company has not accepted the invitation yet. */
const notJoined = (err: unknown) => err instanceof GatewayError && /channel creation request not allowed/i.test(`${err.message} ${err.cause?.details ?? ""}`);

/**
 * Whether a refusal by the orderers passes by itself. Given what handing over a transaction threw.
 * The peer hands a transaction to the channel's orderers one at a time, in a random order, until
 * one takes it.
 *
 * An orderer whose company was invited to a workspace and has not joined yet does not know the
 * channel. It says so, and the peer stops there without asking the others. The next try starts
 * with another orderer.
 *
 * When no orderer took it, the peer names the ones it could not reach at all. If most of the
 * channel's orderers are still running, they are choosing a leader, because one of them has just
 * stopped or started. If most cannot be reached, waiting does not help: too few are running.
 *
 * An orderer that still follows a leader which has gone holds a transaction for seconds before
 * giving it back, so the answer can come too late. Offering it again is safe then too.
 */
function passesByItself(err: unknown, orderers: number): boolean {
  if (!(err instanceof GatewayError)) return false;
  // Too late and cancelled are the same thing seen from two ends: the wait for an answer ran out.
  if (notJoined(err) || err.code === grpc.status.DEADLINE_EXCEEDED || err.code === grpc.status.CANCELLED) return true;
  if (err.code !== grpc.status.UNAVAILABLE) return false;
  const running = orderers - err.details.length;
  return running * 2 > orderers;
}

/** Sends a transaction through endorse, submit and commit, and waits for its block. */
export async function submit<T>(identity: Identity, channel: string, fn: string, options: SubmitOptions): Promise<{ result: T; receipt: Receipt }> {
  const contract = contractOf(identity, channel);
  for (let attempt = 1; ; attempt++) {
    try {
      const started = performance.now();
      const proposal = contract.newProposal(fn, {
        arguments: options.args,
        transientData: options.transient,
        endorsingOrganizations: options.endorsingOrgs,
      });
      const transaction = await proposal.endorse();
      const endorsed = performance.now();
      let offers = 1;
      let submitted: SubmittedTransaction;
      for (;;) {
        try {
          submitted = await transaction.submit();
          break;
        } catch (err) {
          const again = passesByItself(err, orderersOf(channel)) && performance.now() - endorsed < offerFor;
          // An orderer that has not joined is expected for as long as an invitation is open. Anything else is worth a line.
          if (!again || (offers === 1 && !notJoined(err))) {
            console.warn(`[ledger] ${channel}: the orderers did not take ${transaction.getTransactionId().slice(0, 12)} at offer ${offers}, ${again ? "offering it again" : "giving up"}. ${refusal(err)}`);
          }
          if (!again) throw err;
          await pause(Math.min(50 * 2 ** (offers - 1), 800));
          offers++;
        }
      }
      const ordered = performance.now();
      let status: Status;
      try {
        status = await submitted.getStatus();
      } catch (err) {
        // Not the same as a refusal: an orderer has it. A leader that loses the others keeps what
        // it was given and writes it when they return, so nobody can say yet that it failed.
        console.warn(`[ledger] ${channel}: an orderer took ${transaction.getTransactionId().slice(0, 12)}, and no block with it arrived. ${refusal(err)}`);
        throw new ChatError(
          504,
          "LEDGER_NOT_CONFIRMED",
          "An orderer took this, but no block containing it reached your company's peer within 30 seconds. Too few of this channel's orderers may be running for them to agree. It may still be written when they are, so look before sending it again.",
        );
      }
      const committed = performance.now();

      const validation = validationName(status.code);
      if (!status.successful) {
        if (retryable.has(validation) && attempt < 3) continue;
        throw new ChatError(409, "LEDGER_REJECTED", `Every peer marked this transaction ${validation}, so it changed nothing.`);
      }
      const envelope = gatewayProtos.PreparedTransaction.deserializeBinary(transaction.getBytes()).getEnvelope();
      return {
        result: parse<T>(transaction.getResult()),
        receipt: {
          txId: transaction.getTransactionId(),
          block: Number(status.blockNumber),
          validation,
          endorsers: envelope ? decodeEnvelope(envelope.serializeBinary()).endorsers : [],
          endorseMs: Math.round(endorsed - started),
          orderMs: Math.round(ordered - endorsed),
          commitMs: Math.round(committed - ordered),
          attempts: attempt,
          offers,
        },
      };
    } catch (err) {
      throw translate(err);
    }
  }
}

export function closeAll(): void {
  for (const gateway of gateways.values()) gateway.close();
  for (const client of clients.values()) client.close();
  gateways.clear();
  clients.clear();
}
