// Each company's app server follows the blocks its own peer commits, from block 0 onwards.
//
// That stream is what makes the chat live: nothing is pushed from one company to another outside
// the ledger. Alice's message reaches Bob because Birch's peer committed the block that holds it,
// and Birch's app server saw that block arrive.
import type { CloseableAsyncIterable } from "@hyperledger/fabric-gateway";
import type { common } from "@hyperledger/fabric-protos";
import { network, type OrgConfig } from "./config";
import { decodeBlock, type BlockView, type TxView } from "./decode";
import { channelOf, translate } from "./fabric";
import { serviceIdentity } from "./people";

type Listener = (block: BlockView) => void;

export class Feed {
  /** Every block this company's peer holds for the channel, oldest first. */
  readonly blocks: BlockView[] = [];
  state: "starting" | "live" | "down" = "starting";
  error = "";
  private readonly byTx = new Map<string, { block: number; index: number }>();
  private readonly listeners = new Set<Listener>();
  private stream: CloseableAsyncIterable<common.Block> | null = null;
  private stopped = false;

  constructor(
    readonly org: OrgConfig,
    readonly channel: string,
  ) {}

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        // Ask for everything from the first block not yet seen. After a dropped connection this
        // picks up exactly where it left off, so no block is missed or handled twice.
        this.stream = await channelOf(serviceIdentity(this.org), this.channel).getBlockEvents({ startBlock: BigInt(this.blocks.length) });
        this.state = "live";
        this.error = "";
        for await (const block of this.stream) this.add(decodeBlock(this.channel, block));
      } catch (err) {
        this.state = "down";
        this.error = translate(err).message;
      } finally {
        this.stream?.close();
        this.stream = null;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  private add(block: BlockView): void {
    if (block.number !== this.blocks.length) return;
    this.blocks.push(block);
    block.txs.forEach((tx, index) => this.byTx.set(tx.txId, { block: block.number, index }));
    for (const listener of this.listeners) listener(block);
  }

  /** Calls listener for every block from now on. Returns the function that stops it. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The block number a transaction landed in, or null if this peer has not committed it. */
  blockOf(txId: string): number | null {
    return this.byTx.get(txId)?.block ?? null;
  }

  find(txId: string): { block: BlockView; tx: TxView } | null {
    const at = this.byTx.get(txId);
    return at ? { block: this.blocks[at.block], tx: this.blocks[at.block].txs[at.index] } : null;
  }

  get height(): number {
    return this.blocks.length;
  }

  get tip(): string {
    return this.blocks.at(-1)?.hash ?? "";
  }

  stop(): void {
    this.stopped = true;
    this.stream?.close();
  }
}

const feeds = new Map<string, Feed>();

/** Starts one feed for each channel each company is on. */
export function startFeeds(): void {
  for (const workspace of network().workspaces) {
    for (const code of workspace.orgs) {
      const org = network().orgs.find((o) => o.code === code)!;
      const feed = new Feed(org, workspace.channel);
      feeds.set(`${code}/${workspace.channel}`, feed);
      void feed.run();
    }
  }
}

/** A company's view of a channel, or null when that company is not on it. */
export function feedOf(orgCode: string, channel: string): Feed | null {
  return feeds.get(`${orgCode}/${channel}`) ?? null;
}

export function stopFeeds(): void {
  for (const feed of feeds.values()) feed.stop();
  feeds.clear();
}

/** Waits until every feed has caught up with its peer, or the time runs out. */
export async function feedsReady(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  for (;;) {
    const total = [...feeds.values()].reduce((sum, feed) => sum + feed.height, 0);
    const started = [...feeds.values()].every((feed) => feed.height > 0 || feed.state === "down");
    if ((started && total === last) || Date.now() > deadline) return;
    last = total;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
