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
import { connect, hash, signers, GatewayError, StatusCode, type Contract, type Gateway, type Network } from "@hyperledger/fabric-gateway";
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

/** Turns whatever Fabric threw into an error with a code and plain words. */
export function translate(err: unknown): ChatError {
  if (err instanceof ChatError) return err;
  if (err instanceof GatewayError) {
    const texts = [...err.details.map((d) => d.message), err.message];
    // The chaincode's own refusals start with a code, for example CHAT_NOT_MEMBER.
    for (const text of texts) {
      const match = /(CHAT_[A-Z_]+): ([^\n]*)/.exec(text);
      if (match) return new ChatError(statusOf[match[1]] ?? 500, match[1], match[2].trim());
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
      const submitted = await transaction.submit();
      const ordered = performance.now();
      const status = await submitted.getStatus();
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
