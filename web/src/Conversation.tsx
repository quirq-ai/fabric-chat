// One open conversation: its header, its messages and the box to write in.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Blocks, Hash as HashIcon, Info, Link2, Lock, Menu, Pencil, Send, Trash2, TriangleAlert, UserPlus, Users } from "lucide-react";
import { Avatar, Hash, OrgChip, REACTIONS, StorageDots, clock, dayOf, fullTime, glyphOf, listNames, ms, scopeWords, shortClock, useNet } from "./bits";
import { useChat, type Selection } from "./chatctx";
import type { Conversation, Message, Receipt, Thread } from "./types";

export interface PendingPost {
  key: string;
  conv: string;
  text: string;
  error?: string;
}

interface Props {
  conv: Conversation;
  thread: Thread;
  pending: PendingPost[];
  receipts: Record<string, Receipt>;
  selectedTx: string;
  /** How many blocks this company's peer holds, so the next block's number can be named. */
  height: number;
  ledgerOpen: boolean;
  embed: boolean;
  onMenu: () => void;
  onToggleLedger: () => void;
  onSend: (text: string, retryKey?: string) => void;
  onDismiss: (key: string) => void;
  onEdit: (message: Message, text: string) => void;
  onDelete: (message: Message) => void;
  onReact: (message: Message, emoji: string, on: boolean) => void;
  onInspect: (selection: Selection) => void;
  onAddPeople: (members: string[]) => void;
}

export function ConversationPane(props: Props) {
  const { conv, thread, pending, receipts } = props;
  const net = useNet();
  const chat = useChat();
  const [info, setInfo] = useState(false);
  const scope = chat.scopeOf(conv.scope);
  const words = scope ? scopeWords(net, chat.workspace, scope, conv.members.length > 0) : null;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Stay at the newest message unless the reader has scrolled up to read older ones.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [thread.messages.length, pending.length, conv.id]);
  useEffect(() => {
    stick.current = true;
    setInfo(false);
  }, [conv.id, conv.scope]);

  const inspectMessage = (message: Message) => props.onInspect({ txId: message.txId, message: { scope: conv.scope, convId: conv.id, msgId: message.id } });

  return (
    <>
      <header className="conv-head">
        <button className="icon menu-btn" onClick={props.onMenu} aria-label="Show conversations">
          <Menu size={20} />
        </button>
        <div className="conv-title">
          <h1>
            {conv.kind === "channel" ? conv.members.length ? <Lock size={17} /> : <HashIcon size={17} /> : <Users size={17} />}
            {chat.labelOf(conv)}
          </h1>
          {conv.topic && <p>{conv.topic}</p>}
        </div>
        {scope && words && (
          <button className={`scope-pill${words.warn ? " warn" : ""}${info ? " open" : ""}`} onClick={() => setInfo((was) => !was)} aria-expanded={info} title="Where this conversation is kept">
            <StorageDots workspace={chat.workspace} holders={scope.orgs} label={false} />
            <span>{words.short}</span>
            {words.warn ? <TriangleAlert size={14} /> : <Info size={14} />}
          </button>
        )}
        {!props.ledgerOpen && !props.embed && (
          <button className="ghost small" onClick={props.onToggleLedger} title="Under the hood: the ledger">
            <Blocks size={15} /> Ledger
          </button>
        )}
      </header>

      {info && scope && words && <ScopeInfo conv={conv} long={words.long} warn={words.warn} holders={scope.orgs} onAddPeople={props.onAddPeople} />}

      <div
        className="messages"
        ref={scroller}
        onScroll={(event) => {
          const box = event.currentTarget;
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }}
      >
        {thread.messages.length === 0 && pending.length === 0 && (
          <p className="first">
            Nothing here yet. The first message will be written into block {props.height} of the <code>{chat.workspace.channel}</code> ledger.
          </p>
        )}
        {thread.messages.map((message, index) => {
          const before = thread.messages[index - 1];
          const newDay = !before || dayOf(before.sentAt) !== dayOf(message.sentAt);
          const compact = !newDay && !!before && before.author === message.author && !before.deleted && !message.deleted && Date.parse(message.sentAt) - Date.parse(before.sentAt) < 180_000;
          return (
            <Fragment key={message.id}>
              {newDay && (
                <div className="day">
                  <span>{dayOf(message.sentAt)}</span>
                </div>
              )}
              <MessageRow
                message={message}
                compact={compact}
                reactions={thread.reactions[message.id] ?? {}}
                receipt={receipts[message.txId]}
                selected={props.selectedTx === message.txId}
                privateScope={scope?.kind !== "public"}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
                onReact={props.onReact}
                onInspect={() => inspectMessage(message)}
              />
            </Fragment>
          );
        })}
        {pending.map((post) => (
          <article key={post.key} className={`msg pending${post.error ? " failed" : ""}`}>
            <div className="gutter">
              <Avatar name={chat.nameOf(chat.user)} color={chat.orgOf(chat.user).color} />
            </div>
            <div className="body">
              <p className="text">{post.text}</p>
              {post.error ? (
                <p className="send-error">
                  <TriangleAlert size={14} /> {post.error}{" "}
                  <button className="link" onClick={() => props.onSend(post.text, post.key)}>
                    Try again
                  </button>{" "}
                  <button className="link" onClick={() => props.onDismiss(post.key)}>
                    Discard
                  </button>
                </p>
              ) : (
                <p className="stages" aria-live="polite">
                  <i />
                  <i />
                  <i />
                  Being endorsed, ordered and committed…
                </p>
              )}
            </div>
          </article>
        ))}
      </div>

      <Composer key={`${conv.scope}/${conv.id}`} placeholder={conv.kind === "channel" ? `Message #${conv.name}` : `Message ${chat.labelOf(conv)}`} hint={words?.send ?? ""} warn={!!words?.warn} locked={scope?.kind !== "public"} onSend={(text) => {
          stick.current = true;
          props.onSend(text);
        }} />
    </>
  );
}

/* ------------------------------------------------------------------ where a conversation is kept */

function ScopeInfo({ conv, long, warn, holders, onAddPeople }: { conv: Conversation; long: string; warn: boolean; holders: string[]; onAddPeople: (members: string[]) => void }) {
  const net = useNet();
  const chat = useChat();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // Only people whose company keeps this scope can be added: their own node must be able to hold it.
  const eligible = (chat.overview?.people ?? []).filter((p) => !conv.members.includes(p.id) && holders.includes(net.orgOfMsp(p.msp)?.code ?? ""));
  return (
    <section className={`scope-info${warn ? " warn" : ""}`}>
      <p>{long}</p>
      <p className="mono small">
        scope <b>{conv.scope}</b> · key <b>conv~{conv.id}</b>
      </p>
      {conv.members.length > 0 && (
        <div className="member-list">
          {conv.members.map((id) => (
            <span key={id} className="member">
              <Avatar name={chat.nameOf(id)} color={chat.orgOf(id).color} size={22} />
              {chat.nameOf(id)}
            </span>
          ))}
          {conv.kind === "channel" && eligible.length > 0 && !adding && (
            <button className="link" onClick={() => setAdding(true)}>
              <UserPlus size={14} /> Add people
            </button>
          )}
        </div>
      )}
      {adding && (
        <div className="add-people">
          {eligible.map((p) => (
            <label key={p.id}>
              <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((was) => (e.target.checked ? [...was, p.id] : was.filter((id) => id !== p.id)))} />
              {p.name} <OrgChip org={chat.orgOf(p.id)} />
            </label>
          ))}
          <div className="row">
            <button className="ghost small" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              className="primary small"
              disabled={picked.length === 0}
              onClick={() => {
                onAddPeople(picked);
                setAdding(false);
                setPicked([]);
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ one message */

interface RowProps {
  message: Message;
  compact: boolean;
  reactions: Record<string, string[]>;
  receipt?: Receipt;
  selected: boolean;
  privateScope: boolean;
  onEdit: (message: Message, text: string) => void;
  onDelete: (message: Message) => void;
  onReact: (message: Message, emoji: string, on: boolean) => void;
  onInspect: () => void;
}

function MessageRow({ message, compact, reactions, receipt, selected, privateScope, onEdit, onDelete, onReact, onInspect }: RowProps) {
  const net = useNet();
  const chat = useChat();
  const mine = message.author === chat.user;
  const org = chat.orgOf(message.author);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [confirming, setConfirming] = useState(false);

  const save = () => {
    const text = draft.trim();
    if (text && text !== message.text) onEdit(message, text);
    setEditing(false);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    }
    if (event.key === "Escape") setEditing(false);
  };

  return (
    <article className={`msg${compact ? " compact" : ""}${selected ? " selected" : ""}${message.deleted ? " gone" : ""}`} style={{ "--org": org.color } as CSSProperties}>
      <div className="gutter">{compact ? <time title={fullTime(message.sentAt)}>{shortClock(message.sentAt)}</time> : <Avatar name={chat.nameOf(message.author)} color={org.color} />}</div>
      <div className="body">
        {!compact && (
          <header>
            <b>{chat.nameOf(message.author)}</b>
            <OrgChip org={org} />
            <time title={fullTime(message.sentAt)}>{clock(message.sentAt)}</time>
          </header>
        )}

        {message.deleted ? (
          <p className="tomb">
            This message was deleted.{" "}
            <button className="link" onClick={onInspect}>
              Its earlier versions are still on the ledger.
            </button>
          </p>
        ) : editing ? (
          <div className="edit">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={Math.min(8, draft.split("\n").length + 1)} autoFocus maxLength={4000} />
            <div className="row">
              <span className="dim small">{privateScope ? "The old text is replaced on the nodes that hold it." : "The old text stays on the ledger as an earlier version."}</span>
              <button className="ghost small" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary small" onClick={save}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="text">
            {message.text}
            {message.editedAt && (
              <button className="edited" onClick={onInspect} title={`Edited ${fullTime(message.editedAt)}`}>
                (edited)
              </button>
            )}
          </p>
        )}

        {Object.keys(reactions).length > 0 && !message.deleted && (
          <div className="reactions">
            {Object.entries(reactions).map(([emoji, people]) => {
              const on = people.includes(chat.user);
              return (
                <button key={emoji} className={on ? "reaction on" : "reaction"} onClick={() => onReact(message, emoji, !on)} title={listNames(people.map(chat.nameOf))}>
                  {glyphOf(emoji)} <span>{people.length}</span>
                </button>
              );
            })}
          </div>
        )}

        {!compact || receipt || selected ? (
          <button className="proof" onClick={onInspect} title="See this message on the ledger">
            <Link2 size={12} />
            {message.block === null ? "waiting for its block" : `block ${message.block}`}
            <span className="tx">
              tx <Hash value={message.txId} head={6} tail={4} />
            </span>
            {receipt && (
              <span className="receipt">
                endorsed by {listNames([...new Set(receipt.endorsers.map((e) => net.orgOfMsp(e.msp)?.name ?? e.msp))])} in {ms(receipt.endorseMs)} · ordered in {ms(receipt.orderMs)} · committed in {ms(receipt.commitMs)}
              </span>
            )}
          </button>
        ) : null}
      </div>

      {!message.deleted && !editing && (
        <div className="tools">
          {confirming ? (
            <>
              <span className="ask">{privateScope ? "Purge it from every node?" : "Blank it? History stays."}</span>
              <button
                className="danger small"
                onClick={() => {
                  onDelete(message);
                  setConfirming(false);
                }}
              >
                Delete
              </button>
              <button className="ghost small" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              {REACTIONS.map((r) => (
                <button key={r.code} className="icon emoji" title={r.label} aria-label={r.label} onClick={() => onReact(message, r.code, !(reactions[r.code] ?? []).includes(chat.user))}>
                  {r.glyph}
                </button>
              ))}
              {mine && (
                <>
                  <button
                    className="icon"
                    title="Edit"
                    aria-label="Edit"
                    onClick={() => {
                      setDraft(message.text);
                      setEditing(true);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button className="icon" title="Delete" aria-label="Delete" onClick={() => setConfirming(true)}>
                    <Trash2 size={15} />
                  </button>
                </>
              )}
              <button className="icon" title="See it on the ledger" aria-label="See it on the ledger" onClick={onInspect}>
                <Blocks size={15} />
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ the box to write in */

function Composer({ placeholder, hint, warn, locked, onSend }: { placeholder: string; hint: string; warn: boolean; locked: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const clean = text.trim();
    if (!clean) return;
    onSend(clean);
    setText("");
    box.current?.focus();
  };
  return (
    <footer className="composer">
      <div className="composer-box">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          maxLength={4000}
          aria-label={placeholder}
        />
        <button className="send" onClick={send} disabled={!text.trim()} aria-label="Send">
          <Send size={17} />
        </button>
      </div>
      <p className={`composer-hint${warn ? " warn" : ""}`}>
        {locked ? <Lock size={12} /> : warn ? <TriangleAlert size={12} /> : null} {hint} <span className="keys">Enter to send</span>
      </p>
    </footer>
  );
}
