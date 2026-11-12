// The panel on the right: the ledger as this person's own company's peer holds it.
//   Blocks       the chain, newest first, and the transactions in each block
//   Transaction  one transaction, step by step, and which companies hold the message it wrote
//   Network      every company's nodes, whether they agree, and switches to stop and start them
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Database, ExternalLink, EyeOff, Link2, Lock, Play, Square, TriangleAlert, X } from "lucide-react";
import { ApiError, api, type TxDetail } from "./api";
import { Hash, clock, fullTime, listNames, ms, owned, useNet, type Net } from "./bits";
import { useChat, type ChatCtx, type Selection } from "./chatctx";
import type { BlockView, Holding, Receipt, Status, TxView, Version, WriteView } from "./types";

export type LedgerTab = "blocks" | "tx" | "network";

interface Props {
  tab: LedgerTab;
  onTab: (tab: LedgerTab) => void;
  blocks: BlockView[];
  selected: Selection | null;
  receipts: Record<string, Receipt>;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  onProblem: (err: unknown) => void;
}

export function LedgerPanel({ tab, onTab, blocks, selected, receipts, onSelect, onClose, onProblem }: Props) {
  const net = useNet();
  const chat = useChat();
  const org = net.org(chat.me.org);
  return (
    <aside className="ledger" aria-label="The ledger">
      <header className="ledger-head">
        <div>
          <h2>Under the hood</h2>
          <p>
            The <code>{chat.workspace.channel}</code> ledger, as {owned(org.name)} own peer holds it
          </p>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close the ledger panel">
          <X size={18} />
        </button>
      </header>
      <nav className="tabs" role="tablist">
        {(["blocks", "tx", "network"] as const).map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? "on" : ""} onClick={() => onTab(name)}>
            {name === "blocks" ? "Blocks" : name === "tx" ? "Transaction" : "Network"}
          </button>
        ))}
      </nav>
      <div className="ledger-body">
        {tab === "blocks" && <BlockList blocks={blocks} selectedTx={selected?.txId ?? ""} onSelect={onSelect} />}
        {tab === "tx" &&
          (selected ? (
            <TxPanel key={selected.txId} selection={selected} receipt={receipts[selected.txId]} onSelect={onSelect} onProblem={onProblem} />
          ) : (
            <p className="hint">Pick a message's "block" link, or a transaction under Blocks, to follow it through the network.</p>
          ))}
        {tab === "network" && <NetworkView onProblem={onProblem} />}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ saying what a transaction did */

const VERBS: Record<string, string> = {
  Join: "joined the workspace",
  CreateConversation: "started a conversation",
  AddMembers: "added people to a conversation",
  Post: "posted a message",
  Edit: "edited a message",
  Delete: "deleted a message",
  React: "reacted to a message",
};

function describe(tx: TxView, chat: ChatCtx, net: Net): { who: string; did: string; scope: string } {
  if (tx.type === "config") return { who: "The founding companies", did: "set the channel's rules: who is on it, who orders it, and how that can change", scope: "" };
  const org = tx.creator ? net.orgOfMsp(tx.creator.msp) : undefined;
  const isPerson = !!tx.creator && tx.creator.role === "client" && !tx.creator.name.includes("@");
  const who = isPerson ? chat.nameOf(`${tx.creator!.name}@${tx.creator!.msp}`) : org ? `${owned(org.name)} administrator` : "Someone";
  if (tx.chaincode === "_lifecycle") {
    if (tx.fn.startsWith("Approve")) return { who, did: "approved the chat chaincode on its company's behalf", scope: "" };
    if (tx.fn.startsWith("Commit")) return { who, did: "committed the chat chaincode, once enough companies had approved it", scope: "" };
    return { who, did: `called ${tx.fn}`, scope: "" };
  }
  const scope = tx.fn === "Join" ? "public" : (tx.args[0] ?? "");
  let did = VERBS[tx.fn] ?? `called ${tx.fn}`;
  const event = tx.event?.payload as { convId?: string } | undefined;
  if (scope === "public" && event?.convId) {
    const conv = chat.overview?.conversations.find((c) => c.scope === "public" && c.id === event.convId);
    if (conv && tx.fn !== "CreateConversation") did += conv.kind === "channel" ? ` in #${conv.name}` : " in a direct message";
    if (conv && tx.fn === "CreateConversation") did = conv.kind === "channel" ? `started #${conv.name}` : "started a direct message";
  }
  return { who, did, scope };
}

function ScopeTag({ scope }: { scope: string }) {
  const net = useNet();
  const chat = useChat();
  const known = chat.workspace.scopes.find((s) => s.name === scope);
  if (!scope || scope === "public") return null;
  const names = known ? listNames(known.orgs.map((code) => net.org(code).name)) : scope;
  // A company outside the scope sees that something happened in it, and nothing more.
  const mine = known?.orgs.includes(chat.me.org) ?? false;
  return (
    <span className={`scope-tag${mine ? "" : " shut"}`} title={mine ? `Private to ${names}` : `Private to ${names}. Your company's peer holds only hashes of this.`}>
      {mine ? <Lock size={11} /> : <EyeOff size={11} />} {names}
    </span>
  );
}

/* ------------------------------------------------------------------ Blocks */

function BlockList({ blocks, selectedTx, onSelect }: { blocks: BlockView[]; selectedTx: string; onSelect: (selection: Selection) => void }) {
  const net = useNet();
  const chat = useChat();
  if (blocks.length === 0) return <p className="hint">Reading the chain…</p>;
  const newest = [...blocks].reverse();
  const select = (tx: TxView) => {
    const event = tx.event?.payload as { scope?: string; convId?: string; msgId?: string } | undefined;
    const message = event?.scope === "public" && event.convId && event.msgId ? { scope: "public", convId: event.convId, msgId: event.msgId } : undefined;
    onSelect({ txId: tx.txId, message });
  };
  return (
    <div className="chain">
      <p className="hint">
        {blocks[blocks.length - 1].number + 1} blocks. Each one names the hash of the block before it, so no earlier block can be changed without every later hash changing too.
      </p>
      {newest.map((block) => (
        <article key={block.number} className="block">
          <header>
            <b>Block {block.number}</b>
            <span>
              hash <Hash value={block.hash} />
            </span>
          </header>
          <ol>
            {block.txs.map((tx) => {
              const said = describe(tx, chat, net);
              return (
                <li key={tx.txId || tx.index}>
                  <button className={`txrow${selectedTx === tx.txId ? " on" : ""}`} onClick={() => select(tx)} disabled={!tx.txId}>
                    <i className={tx.valid ? "ok" : "bad"} title={tx.validation} />
                    <span className="said">
                      <b>{said.who}</b> {said.did}
                      {!tx.valid && <em> · {tx.validation}</em>}
                    </span>
                    <ScopeTag scope={said.scope} />
                  </button>
                </li>
              );
            })}
          </ol>
          {block.number > 0 && (
            <footer>
              <Link2 size={11} /> previous <Hash value={block.previousHash} />
            </footer>
          )}
        </article>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Transaction */

const WHY_INVALID: Record<string, string> = {
  MVCC_READ_CONFLICT: "Another transaction changed a record this one had read, and reached a block first. This one was recorded but changed nothing.",
  PHANTOM_READ_CONFLICT: "The set of records this transaction searched changed before it was ordered. It was recorded but changed nothing.",
  ENDORSEMENT_POLICY_FAILURE: "Not enough of the right companies had signed it. It was recorded but changed nothing.",
};

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Fold({ title, children, open = false }: { title: ReactNode; children: ReactNode; open?: boolean }) {
  const [shown, setShown] = useState(open);
  return (
    <div className="fold">
      <button className="fold-head" onClick={() => setShown((was) => !was)} aria-expanded={shown}>
        {shown ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {title}
      </button>
      {shown && <div className="fold-body">{children}</div>}
    </div>
  );
}

function TxPanel({ selection, receipt, onSelect, onProblem }: { selection: Selection; receipt?: Receipt; onSelect: (selection: Selection) => void; onProblem: (err: unknown) => void }) {
  const net = useNet();
  const chat = useChat();
  const [detail, setDetail] = useState<TxDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [held, setHeld] = useState<{ key: string; holdings: Holding[] } | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const { txId, message } = selection;

  useEffect(() => {
    let stale = false;
    void (async () => {
      // The peer's block can arrive a moment after the message does, so ask a few times.
      for (let attempt = 0; attempt < 10 && !stale; attempt++) {
        try {
          const found = await api.tx(chat.user, chat.ws, txId);
          if (!stale) setDetail(found);
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || err.code !== "NO_SUCH_TX") {
            if (!stale) onProblem(err);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      if (!stale) setMissing(true);
    })();
    return () => {
      stale = true;
    };
  }, [txId, chat.user, chat.ws, onProblem]);

  useEffect(() => {
    if (!message) return;
    let stale = false;
    api.holdings(chat.user, chat.ws, message.scope, message.convId, message.msgId).then(
      (found) => !stale && setHeld(found),
      () => !stale && setHeld(null),
    );
    if (message.scope === "public") {
      api.history(chat.user, chat.ws, message.convId, message.msgId).then(
        (found) => !stale && setVersions(found),
        () => !stale && setVersions(null),
      );
    }
    return () => {
      stale = true;
    };
  }, [message?.scope, message?.convId, message?.msgId, txId, chat.user, chat.ws]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) return <p className="hint">{owned(net.org(chat.me.org).name)} peer has not committed that transaction.</p>;
  if (!detail) return <p className="hint">Looking it up on the peer…</p>;

  const { tx, block } = detail;
  const said = describe(tx, chat, net);
  const scope = chat.workspace.scopes.find((s) => s.name === said.scope);
  const creatorOrg = tx.creator ? net.orgOfMsp(tx.creator.msp) : undefined;
  const ours = tx.chaincode === net.info.chaincode.name;
  const writes = tx.writes.filter((w) => w.namespace === tx.chaincode);
  const reads = tx.reads.filter((r) => r.namespace === tx.chaincode);
  const orderers = chat.workspace.orgs.map((code) => net.org(code).orderer.split(".")[0] + "." + net.org(code).orderer.split(".")[1]);
  const rule = !ours
    ? ""
    : !scope || scope.kind === "public"
      ? `The rule on this channel: more than half of its ${chat.workspace.orgs.length} companies must sign.`
      : scope.kind === "shared"
        ? "Only the companies that keep this scope were asked, so no other company's peer ever received the text."
        : `Only ${owned(net.org(scope.orgs[0]).name)} own peer was asked: the scope belongs to that company alone.`;

  return (
    <div className="tx">
      <p className="tx-said">
        <b>{said.who}</b> {said.did}. <ScopeTag scope={said.scope} />
      </p>

      {tx.type === "transaction" && (
        <ol className="timeline">
          <li>
            <h4>1 · Signed</h4>
            <p>
              by <b>{said.who}</b>
              {creatorOrg ? ` of ${creatorOrg.name}` : ""}, at {clock(tx.at)}
            </p>
            <p className="mono small">
              CN={tx.creator?.name} · OU={tx.creator?.role} · {tx.creator?.msp}
            </p>
            <p className="dim small">The chaincode took the author from this certificate, not from anything typed.</p>
          </li>
          <li>
            <h4>2 · Endorsed</h4>
            <ul className="signers">
              {tx.endorsers.map((endorser) => {
                const org = net.orgOfMsp(endorser.msp);
                return (
                  <li key={endorser.msp + endorser.name} style={{ "--org": org?.color ?? "#888" } as CSSProperties}>
                    <i className="dot on" /> <span className="mono">{endorser.name}</span> <span className="dim">{org?.name}</span>
                  </li>
                );
              })}
            </ul>
            <p className="dim small">Each of these peers ran the chaincode and signed the same result. {rule}</p>
            {receipt && <p className="mono small">took {ms(receipt.endorseMs)}</p>}
          </li>
          <li>
            <h4>3 · Ordered</h4>
            <p>
              into <b>block {block.number}</b>, as transaction {tx.index + 1} of {block.txCount}
            </p>
            <p className="dim small">
              by this channel's orderers ({listNames(orderers)}), which agree on one order using Raft. They never run the chaincode
              {scope && scope.kind !== "public" ? ", and for this transaction they saw only hashes." : "."}
            </p>
            {receipt && <p className="mono small">handed over in {ms(receipt.orderMs)}</p>}
          </li>
          <li className={tx.valid ? "good" : "bad"}>
            <h4>4 · Checked and committed</h4>
            <p>
              {tx.valid ? <Check size={14} /> : <TriangleAlert size={14} />} <b>{tx.validation}</b>
            </p>
            <p className="dim small">
              {tx.valid
                ? "Every peer on the channel checked the signatures against the rule, checked that nothing this transaction read had changed, and then applied it to its own copy."
                : (WHY_INVALID[tx.validation] ?? "Every peer recorded it and applied none of its changes.")}
            </p>
            {receipt && (
              <p className="mono small">
                in a block {ms(receipt.commitMs)} later{receipt.attempts > 1 ? ` · sent ${receipt.attempts} times` : ""}
              </p>
            )}
          </li>
        </ol>
      )}

      {versions && versions.length > 1 && (
        <section>
          <h3>Every version, still on the ledger</h3>
          <ol className="versions">
            {versions.map((v, index) => (
              <li key={v.txId} className={v.txId === txId ? "on" : ""}>
                <button onClick={() => onSelect({ txId: v.txId, message })} title={fullTime(v.at)}>
                  <span className="when">
                    {index === 0 ? "Posted" : v.deleted ? "Deleted" : "Edited"} · block {v.block ?? "?"} · {clock(v.at)}
                  </span>
                  <span className={v.deleted ? "dim" : ""}>{v.deleted ? "(text removed)" : v.text}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="dim small">A later transaction can change what the message says now. It cannot change the blocks that hold what it said before.</p>
        </section>
      )}

      {message && held && (
        <section>
          <h3>Who holds this message</h3>
          <ul className="holdings">
            {held.holdings.map((holding) => {
              const org = net.org(holding.org);
              const state = !holding.onChannel ? "none" : holding.held ? "text" : holding.ledgerHash ? "hash" : "gone";
              return (
                <li key={holding.org} className={state} style={{ "--org": org.color } as CSSProperties}>
                  <i className={state === "text" ? "dot on" : "dot"} />
                  <div>
                    <b>{org.name}</b>
                    <p>
                      {state === "text" && (holding.matches ? "Its peer holds the text, and the text matches the hash on the ledger." : "Its peer holds the text.")}
                      {state === "hash" && "Its peer holds only the hash: proof of what was said, without the words."}
                      {state === "gone" && "Its peer holds nothing for this key any more."}
                      {state === "none" && "Not on this channel. Its nodes hold no part of this ledger."}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          {held.holdings.find((h) => h.ledgerHash) && (
            <p className="mono small">
              hash on the ledger <Hash value={held.holdings.find((h) => h.ledgerHash)!.ledgerHash} head={12} tail={8} />
            </p>
          )}
          <p className="mono small dim">key {held.key}</p>
        </section>
      )}

      {tx.type === "transaction" && (
        <section>
          <h3>What the block records</h3>
          <dl className="facts">
            <dt>Function</dt>
            <dd className="mono">
              {tx.chaincode}.{tx.fn}
            </dd>
            <dt>Arguments</dt>
            <dd>
              {tx.args.length === 0 && <span className="dim">none</span>}
              {tx.args.map((arg, index) =>
                arg === "" ? (
                  <p key={index} className="empty-arg">
                    <EyeOff size={12} /> empty. The details travelled in the <b>transient</b> field: the endorsing peers saw them, and the block does not carry them.
                  </p>
                ) : (
                  <pre key={index}>{pretty(arg)}</pre>
                ),
              )}
            </dd>
          </dl>
          <Fold title={`${writes.length} ${writes.length === 1 ? "write" : "writes"}`} open>
            {writes.length === 0 && <p className="dim small">Nothing was written.</p>}
            {writes.map((write, index) => (
              <WriteRow key={index} write={write} />
            ))}
          </Fold>
          <Fold title={`${reads.length} ${reads.length === 1 ? "read" : "reads"}, each with the version it saw`}>
            {reads.map((read, index) => (
              <p key={index} className="mono small rw">
                {read.collection ? <Hash value={read.key} head={10} tail={6} /> : read.key} <span className="dim">@ {read.version || "did not exist"}</span>
              </p>
            ))}
            <p className="dim small">If any of these had changed by the time the block was checked, the transaction would be marked MVCC_READ_CONFLICT.</p>
          </Fold>
          {tx.event && (
            <Fold title={`event "${tx.event.name}"`}>
              <pre>{JSON.stringify(tx.event.payload, null, 2)}</pre>
              <p className="dim small">Events are part of the block, so every company on the channel receives them.</p>
            </Fold>
          )}
        </section>
      )}

      <section>
        <h3>The block</h3>
        <dl className="facts">
          <dt>Number</dt>
          <dd>{block.number}</dd>
          <dt>Hash</dt>
          <dd>
            <Hash value={block.hash} head={16} tail={10} />
          </dd>
          <dt>Previous</dt>
          <dd>
            <Hash value={block.previousHash} head={16} tail={10} />
          </dd>
          <dt>Transaction</dt>
          <dd>
            <Hash value={tx.txId} head={16} tail={10} />
          </dd>
        </dl>
      </section>
    </div>
  );
}

function WriteRow({ write }: { write: WriteView }) {
  if (write.collection) {
    return (
      <div className="write private">
        <p className="mono small">
          <Lock size={11} /> {write.collection}
        </p>
        <p className="mono small">
          hash of key <Hash value={write.key} head={10} tail={6} />
        </p>
        <p className="mono small">
          {write.purge ? "purged: every peer drops the record and its history" : write.delete ? "deleted" : <>hash of value <Hash value={write.valueHash ?? ""} head={10} tail={6} /></>}
        </p>
      </div>
    );
  }
  return (
    <div className="write">
      <p className="mono small">
        {write.key} {write.delete && <em>deleted</em>}
      </p>
      {!write.delete && <pre>{pretty(write.value ?? "")}</pre>}
    </div>
  );
}

/* ------------------------------------------------------------------ Network */

function NetworkView({ onProblem }: { onProblem: (err: unknown) => void }) {
  const net = useNet();
  const chat = useChat();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let stale = false;
    const load = () => api.status().then((next) => !stale && setStatus(next), () => undefined);
    load();
    const timer = window.setInterval(load, 2500);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, []);

  const flip = async (name: string, action: "stop" | "start") => {
    setBusy(name);
    try {
      await api.node(chat.user, name, action);
      setStatus(await api.status());
    } catch (err) {
      onProblem(err);
    } finally {
      setBusy("");
    }
  };

  if (!status) return <p className="hint">Asking each node…</p>;
  const ledgers = status.ledgers.filter((l) => l.channel === chat.ws);
  const on = ledgers.filter((l) => l.onChannel);
  const top = Math.max(...on.map((l) => l.height));
  const agree = on.every((l) => l.height === top && l.tip === on[0].tip && l.state === "live");

  return (
    <div className="network">
      <section>
        <h3>Do they hold the same ledger?</h3>
        <p className={`verdict ${agree ? "good" : "warn"}`}>
          {agree ? <Check size={15} /> : <TriangleAlert size={15} />}
          {agree ? `All ${on.length} peers on this channel hold the same ${top} blocks.` : "Not every peer is in step right now."}
        </p>
        <ul className="heights">
          {ledgers.map((ledger) => {
            const org = net.org(ledger.org);
            return (
              <li key={ledger.org} style={{ "--org": org.color } as CSSProperties} className={ledger.onChannel ? "" : "off"}>
                <i className={ledger.onChannel ? "dot on" : "dot"} />
                <b>{org.name}</b>
                {ledger.onChannel ? (
                  <span>
                    {ledger.height} blocks · newest <Hash value={ledger.tip} head={6} tail={4} />
                    {ledger.state !== "live" && <em> · not answering</em>}
                    {ledger.state === "live" && ledger.height < top && <em> · {top - ledger.height} behind</em>}
                  </span>
                ) : (
                  <span>not on this channel: holds nothing</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="dim small">Nobody copies the ledger from anybody else's database. Each peer gets the blocks from the orderers and checks every transaction itself. Equal hashes mean they all reached the same result.</p>
      </section>

      <section>
        <h3>The nodes</h3>
        {net.info.orgs.map((org) => (
          <div key={org.code} className="org-nodes" style={{ "--org": org.color } as CSSProperties}>
            <h4>{org.name}</h4>
            <ul>
              {status.nodes
                .filter((node) => node.org === org.code)
                .map((node) => {
                  const running = node.state === "running";
                  return (
                    <li key={node.name}>
                      <i className={running ? "lamp on" : "lamp"} title={node.state} />
                      <span className="kind">{node.kind === "ca" ? "CA" : node.kind}</span>
                      <span className="mono small">{node.name}</span>
                      {node.kind === "database" && running && (
                        <a href={org.couchdb} target="_blank" rel="noreferrer" title="Open this company's state database (CouchDB). The admin password is in .generated/secrets.json">
                          <Database size={13} />
                          <ExternalLink size={11} />
                        </a>
                      )}
                      {node.controllable && (
                        <button className="ghost tiny" disabled={busy === node.name} onClick={() => flip(node.name, running ? "stop" : "start")}>
                          {running ? <Square size={11} /> : <Play size={11} />} {busy === node.name ? "…" : running ? "Stop" : "Start"}
                        </button>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </section>

      <section>
        <h3>Things to try</h3>
        <ul className="try">
          <li>
            <b>Stop one company's peer</b>, then post in an open channel. It still commits: two of three companies can endorse. Start the peer again and watch its block count catch up.
          </li>
          <li>
            <b>Stop the peer of one side of a private channel</b>, then post there. It is refused: both companies that keep the scope must endorse.
          </li>
          <li>
            <b>Stop one orderer.</b> Nothing changes: Raft needs two of three. Stop a second and nothing commits until one comes back.
          </li>
        </ul>
      </section>
    </div>
  );
}
