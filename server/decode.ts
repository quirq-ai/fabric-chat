// Turns a block, as a peer delivers it, into plain facts the UI can show: who signed each
// transaction, which peers endorsed it, what it read and wrote, and whether it was accepted.
//
// A block is nested envelopes. From the outside in:
//   Block            header (number, previous hash, hash of the data), data, metadata
//   Envelope         one per transaction: a payload and the sender's signature over it
//   Payload          channel header (transaction ID, time, type) and signature header (the sender's certificate)
//   Transaction      the chaincode call that was proposed, and the endorsed result
//   endorsed result  the read/write set every endorser agreed on, and each endorser's signature
import { createHash } from "node:crypto";
import { common, ledger, msp, peer } from "@hyperledger/fabric-protos";
import { partyOf, type Party } from "./people";

const { kvrwset } = ledger.rwset;

export interface ReadView {
  namespace: string;
  /** Set when the read was of a private data collection. Then key is the hash of the real key. */
  collection?: string;
  key: string;
  /** The version read, as "block:transaction", or "" when the key did not exist yet. */
  version: string;
}

export interface WriteView {
  namespace: string;
  /** Set when the write was to a private data collection. Then only hashes are in the block. */
  collection?: string;
  /** The key, or for a private write the hash of the key. */
  key: string;
  delete: boolean;
  purge: boolean;
  bytes: number;
  /** The value written, for a public write. A private write never carries its value. */
  value?: string;
  /** The hash of the value written, for a private write. */
  valueHash?: string;
}

export interface TxView {
  txId: string;
  /** Position in the block. */
  index: number;
  /** "transaction" for a chaincode call, "config" for a change to the channel's own rules. */
  type: "transaction" | "config" | "other";
  at: string;
  creator: Party | null;
  chaincode: string;
  fn: string;
  /** The arguments as the block records them. Anything not readable as text is shown by its size. */
  args: string[];
  endorsers: Party[];
  reads: ReadView[];
  writes: WriteView[];
  event: { name: string; payload: unknown } | null;
  /** The validation result each peer reached on its own, such as VALID or MVCC_READ_CONFLICT. */
  validation: string;
  valid: boolean;
}

export interface BlockView {
  channel: string;
  number: number;
  hash: string;
  previousHash: string;
  dataHash: string;
  txs: TxView[];
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const validationNames = new Map<number, string>(Object.entries(peer.TxValidationCode).map(([name, code]) => [code as number, name]));

/* ------------------------------------------------------------------ the block's own hash */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const der = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);

function derInteger(value: number): Buffer {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  if (bytes.length === 0 || bytes[0] >= 0x80) bytes.unshift(0);
  return der(0x02, Buffer.from(bytes));
}

/**
 * A block's hash is the SHA-256 of its header: its number, the previous block's hash and the hash
 * of its own data, in ASN.1 form. Each block names the one before it, so changing any old block
 * would change every hash after it. That chain is what makes the ledger tamper-evident.
 */
export function blockHash(number: number, previousHash: Uint8Array, dataHash: Uint8Array): string {
  const header = der(0x30, Buffer.concat([derInteger(number), der(0x04, Buffer.from(previousHash)), der(0x04, Buffer.from(dataHash))]));
  return createHash("sha256").update(header).digest("hex");
}

/* ------------------------------------------------------------------ transactions */

function party(serialized: Uint8Array): Party | null {
  try {
    const identity = msp.SerializedIdentity.deserializeBinary(serialized);
    return partyOf(identity.getMspid(), Buffer.from(identity.getIdBytes_asU8()).toString("utf8"));
  } catch {
    return null;
  }
}

/** Text is shown as it is. Anything else, such as the protobuf arguments of a lifecycle call, by its size. */
function readable(bytes: Uint8Array, limit = 2000): string {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("�") || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return `(${bytes.length} bytes, not text)`;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function version(v: InstanceType<typeof kvrwset.Version> | undefined): string {
  return v ? `${v.getBlockNum()}:${v.getTxNum()}` : "";
}

function rwsetOf(results: Uint8Array): { reads: ReadView[]; writes: WriteView[] } {
  const reads: ReadView[] = [];
  const writes: WriteView[] = [];
  if (results.length === 0) return { reads, writes };
  for (const ns of ledger.rwset.TxReadWriteSet.deserializeBinary(results).getNsRwsetList()) {
    const namespace = ns.getNamespace();
    const open = kvrwset.KVRWSet.deserializeBinary(ns.getRwset_asU8());
    for (const read of open.getReadsList()) reads.push({ namespace, key: read.getKey(), version: version(read.getVersion()) });
    for (const write of open.getWritesList()) {
      const value = write.getValue_asU8();
      writes.push({ namespace, key: write.getKey(), delete: write.getIsDelete(), purge: false, bytes: value.length, value: readable(value) });
    }
    // For a private data collection the block carries hashes only: of each key, and of each value.
    for (const collection of ns.getCollectionHashedRwsetList()) {
      const hashed = kvrwset.HashedRWSet.deserializeBinary(collection.getHashedRwset_asU8());
      const name = collection.getCollectionName();
      for (const read of hashed.getHashedReadsList()) {
        reads.push({ namespace, collection: name, key: hex(read.getKeyHash_asU8()), version: version(read.getVersion()) });
      }
      for (const write of hashed.getHashedWritesList()) {
        writes.push({
          namespace,
          collection: name,
          key: hex(write.getKeyHash_asU8()),
          delete: write.getIsDelete(),
          purge: write.getIsPurge(),
          bytes: 0,
          valueHash: hex(write.getValueHash_asU8()),
        });
      }
    }
  }
  return { reads, writes };
}

/** Decodes one transaction envelope. The validation result is not in the envelope: see decodeBlock. */
export function decodeEnvelope(bytes: Uint8Array, index = 0): TxView {
  const envelope = common.Envelope.deserializeBinary(bytes);
  const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
  const header = payload.getHeader();
  const channelHeader = common.ChannelHeader.deserializeBinary(header?.getChannelHeader_asU8() ?? new Uint8Array());
  const signatureHeader = common.SignatureHeader.deserializeBinary(header?.getSignatureHeader_asU8() ?? new Uint8Array());
  const time = channelHeader.getTimestamp();
  const kind = channelHeader.getType();

  const tx: TxView = {
    txId: channelHeader.getTxId(),
    index,
    type: kind === common.HeaderType.ENDORSER_TRANSACTION ? "transaction" : kind === common.HeaderType.CONFIG ? "config" : "other",
    at: time ? new Date(time.getSeconds() * 1000 + Math.floor(time.getNanos() / 1e6)).toISOString() : "",
    creator: party(signatureHeader.getCreator_asU8()),
    chaincode: "",
    fn: "",
    args: [],
    endorsers: [],
    reads: [],
    writes: [],
    event: null,
    validation: "",
    valid: false,
  };
  if (tx.type !== "transaction") return tx;

  for (const action of peer.Transaction.deserializeBinary(payload.getData_asU8()).getActionsList()) {
    const actionPayload = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8());

    // What was asked: the chaincode, the function and its arguments. The transient field is not here.
    const proposal = peer.ChaincodeProposalPayload.deserializeBinary(actionPayload.getChaincodeProposalPayload_asU8());
    const spec = peer.ChaincodeInvocationSpec.deserializeBinary(proposal.getInput_asU8()).getChaincodeSpec();
    const args = spec?.getInput()?.getArgsList_asU8() ?? [];
    tx.chaincode = spec?.getChaincodeId()?.getName() ?? "";
    tx.fn = args.length ? readable(args[0], 80) : "";
    tx.args = args.slice(1).map((arg) => readable(arg));

    // What the endorsing peers agreed happened, and their signatures on it.
    const endorsed = actionPayload.getAction();
    if (!endorsed) continue;
    for (const endorsement of endorsed.getEndorsementsList()) {
      const who = party(endorsement.getEndorser_asU8());
      if (who) tx.endorsers.push(who);
    }
    const response = peer.ProposalResponsePayload.deserializeBinary(endorsed.getProposalResponsePayload_asU8());
    const chaincodeAction = peer.ChaincodeAction.deserializeBinary(response.getExtension_asU8());
    const sets = rwsetOf(chaincodeAction.getResults_asU8());
    tx.reads.push(...sets.reads);
    tx.writes.push(...sets.writes);
    const eventBytes = chaincodeAction.getEvents_asU8();
    if (eventBytes.length > 0) {
      const event = peer.ChaincodeEvent.deserializeBinary(eventBytes);
      if (event.getEventName()) {
        const text = Buffer.from(event.getPayload_asU8()).toString("utf8");
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Left as text.
        }
        tx.event = { name: event.getEventName(), payload: parsed };
      }
    }
  }
  return tx;
}

export function decodeBlock(channel: string, block: common.Block): BlockView {
  const header = block.getHeader();
  const number = header?.getNumber() ?? 0;
  const previousHash = header?.getPreviousHash_asU8() ?? new Uint8Array();
  const dataHash = header?.getDataHash_asU8() ?? new Uint8Array();
  // Each peer checks every transaction itself and records the result here, one byte per transaction.
  const filter = block.getMetadata()?.getMetadataList_asU8()[common.BlockMetadataIndex.TRANSACTIONS_FILTER] ?? new Uint8Array();
  const txs = (block.getData()?.getDataList_asU8() ?? []).map((bytes, index) => {
    const tx = decodeEnvelope(bytes, index);
    const code = filter[index] ?? peer.TxValidationCode.NOT_VALIDATED;
    tx.validation = validationNames.get(code) ?? String(code);
    tx.valid = code === peer.TxValidationCode.VALID;
    return tx;
  });
  return { channel, number, hash: blockHash(number, previousHash, dataHash), previousHash: hex(previousHash), dataHash: hex(dataHash), txs };
}
