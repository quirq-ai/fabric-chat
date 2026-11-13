// "Other companies", for an administrator on a company's own server: this company's card, the
// workspaces it shares, starting one, and accepting an invitation to one.
//
// Sharing a workspace takes three steps, and nothing secret changes hands in any of them:
//   1. The two administrators send each other their company's card.
//   2. One of them starts the workspace from the other's card, and sends back an invitation.
//   3. The other accepts it. The two nodes then agree on the rules by themselves.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { BadgeCheck, Check, Copy, Download, Hourglass, Plus, TriangleAlert, X } from "lucide-react";
import { ApiError, account } from "./api";
import { Avatar, Modal, listNames, owned, useNet } from "./bits";
import type { CardView, CompaniesView, InvitationView, Reach, SharedWorkspace } from "./types";

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** A fingerprint in groups of four, the way two people read one to each other. */
function Fingerprint({ value }: { value: string }) {
  return (
    <span className="fingerprint mono" title="SHA-256 of the company's root certificate">
      {value.match(/.{1,4}/g)?.join(" ") ?? value}
    </span>
  );
}

/** A card or an invitation as text to send: shown, copied, or saved as a file. */
function TextToSend({ text, file, label }: { text: string; file: string; label: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    box.current?.select();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard on a plain http page: the text is selected, ready to copy by hand.
    }
  };
  const save = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = file;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <div className="to-send">
      <textarea ref={box} value={text} readOnly rows={3} aria-label={label} onFocus={(e) => e.target.select()} />
      <div className="row">
        <button type="button" className="primary small" onClick={copy}>
          <Copy size={13} /> {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="ghost small" onClick={save}>
          <Download size={13} /> Save as a file
        </button>
      </div>
    </div>
  );
}

export function CompaniesDialog({ onClose }: { onClose: () => void }) {
  const net = useNet();
  const company = net.info.company!;
  const [view, setView] = useState<CompaniesView | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [accepting, setAccepting] = useState(false);
  /** The invitation just made, kept on screen until it has been sent. */
  const [made, setMade] = useState<{ channel: string; text: string } | null>(null);

  const load = useCallback(
    () =>
      account.companies().then(
        (found) => setView(found),
        (err) => setError(messageOf(err, "This could not be read.")),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // While a workspace is on its way to being ready, look again every few seconds.
  const unsettled = view?.workspaces.some((w) => w.status !== "ready") ?? false;
  useEffect(() => {
    if (!unsettled) return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [unsettled, load]);

  return (
    <Modal title="Other companies" onClose={onClose} width={700}>
      <div className="members sharing">
        <p className="dim">
          {company.name} can share a workspace with any company that runs Fabric Chat on its own server. Swap cards with them, then one of you starts the workspace and the other accepts the invitation. Nothing secret
          changes hands.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!view && !error && <p className="dim">Reading…</p>}

        {view && (
          <>
            <section>
              <h3>1 · {owned(company.name)} card</h3>
              <p className="dim small">Send this to the other company's administrator, and ask for theirs. It holds the company's name, its root certificate and where its nodes are.</p>
              <TextToSend text={view.card.text} file={`${view.card.id}.card.txt`} label={`${owned(company.name)} card`} />
              <p className="small">
                <span className="dim">Fingerprint </span>
                <Fingerprint value={view.card.fingerprint} />
              </p>
            </section>

            <section>
              <h3>2 · Start a shared workspace, or accept an invitation to one</h3>
              {!starting && !accepting && (
                <div className="row wrap">
                  <button className="ghost" onClick={() => setStarting(true)}>
                    <Plus size={15} /> Start a workspace
                  </button>
                  <button className="ghost" onClick={() => setAccepting(true)}>
                    <BadgeCheck size={15} /> Accept an invitation
                  </button>
                </div>
              )}
              {starting && (
                <StartForm
                  onCancel={() => setStarting(false)}
                  onMade={(next, channel, text) => {
                    setView(next);
                    setMade({ channel, text });
                    setStarting(false);
                  }}
                />
              )}
              {accepting && (
                <AcceptForm
                  onCancel={() => setAccepting(false)}
                  onJoined={(next) => {
                    setView(next);
                    setAccepting(false);
                  }}
                />
              )}
              {made && (
                <div className="link-box">
                  <p className="link-head">
                    <BadgeCheck size={16} />
                    <span>
                      <b>The workspace is started.</b> Now send this invitation to the other {view.workspaces.find((w) => w.channel === made.channel)?.members.length === 2 ? "company" : "companies"}.
                    </span>
                  </p>
                  <p>They accept it in their own app, here under Other companies. It can be copied again later from the list below.</p>
                  <TextToSend text={made.text} file={`${made.channel}.invitation.txt`} label="The invitation" />
                  <div className="row end">
                    <button className="ghost small" onClick={() => setMade(null)}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section>
              <h3>Shared workspaces</h3>
              {view.workspaces.length === 0 && <p className="dim">None yet.</p>}
              <ul className="shared-list">
                {view.workspaces.map((workspace) => (
                  <WorkspaceRow key={workspace.channel} workspace={workspace} onProblem={setError} />
                ))}
              </ul>
              <p className="dim small">A shared workspace takes messages while more than half of its companies' nodes are running. Leaving one, and adding a company to one, are not built yet.</p>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Whether this company's server can reach another company's node. Over the internet a closed port,
 * or a name that points somewhere else, is the likeliest thing to be wrong, and a workspace whose
 * nodes cannot reach each other simply never becomes ready.
 */
function ReachLine({ reach, name }: { reach: Reach | null | undefined; name: string }) {
  if (reach === undefined) return <p className="dim small">Trying to reach their node from this server…</p>;
  if (reach === null) return <p className="dim small">Whether this server can reach their node could not be tried just now.</p>;
  const tried = [reach.peer, reach.orderer, reach.cluster];
  const silent = tried.filter((probe) => !probe.reached);
  const wrong = tried.filter((probe) => probe.reached && !probe.proven);
  if (silent.length === 0 && wrong.length === 0) {
    return (
      <p className="good small">
        <Check size={13} /> This server reaches their node. Its peer and its orderer answer, each with a certificate signed under this card.
      </p>
    );
  }
  return (
    <>
      {wrong.length > 0 && (
        <p className="error">
          <TriangleAlert size={13} /> Something answers at {listNames(wrong.map((probe) => probe.address))}, but it is not {owned(name)} node: its certificate was not signed under this card. Do not go on until you know why.
        </p>
      )}
      {silent.length > 0 && (
        <p className="warn small">
          <TriangleAlert size={13} /> This server cannot reach {listNames(silent.map((probe) => probe.address))}. The workspace will not become ready until it can. Ask {name} whether ports 7051, 7050 and 7055 are open on their
          server, and whether these names point at it.
        </p>
      )}
    </>
  );
}

/** One shared workspace and how far it has got. */
function WorkspaceRow({ workspace, onProblem }: { workspace: SharedWorkspace; onProblem: (message: string) => void }) {
  const [invitation, setInvitation] = useState("");
  const me = workspace.members.find((m) => m.self);
  const others = workspace.members.filter((m) => !m.self);
  const mine = workspace.createdBy === me?.id;
  const approved = workspace.members.filter((m) => workspace.approvals[m.id]);
  const waitingFor = workspace.members.filter((m) => !workspace.approvals[m.id]);

  const fetchInvitation = () =>
    account.invitationOf(workspace.channel).then(
      (found) => setInvitation(found.invitation),
      (err) => onProblem(messageOf(err, "The invitation could not be read.")),
    );

  return (
    <li>
      <div className="shared-head">
        <b>{workspace.name}</b>
        <span className="mono dim small">channel {workspace.channel}</span>
        <span className="shared-members">
          {workspace.members.map((m) => (
            <span key={m.id} className="orgchip" style={{ "--org": m.color } as CSSProperties} title={m.id}>
              {m.name}
            </span>
          ))}
        </span>
      </div>
      {workspace.status === "ready" && (
        <p className="good shared-status">
          <Check size={14} /> Ready. It appears at the left edge of the chat for everyone at {me?.name}, a few seconds after this.
        </p>
      )}
      {workspace.status === "waiting" && (
        <p className="warn shared-status">
          <Hourglass size={14} /> {mine ? `Waiting for ${listNames(others.map((m) => m.name))} to accept the invitation.` : "Reaching the other companies' nodes…"}
        </p>
      )}
      {workspace.status === "agreeing" && (
        <p className="warn shared-status">
          <Hourglass size={14} /> Agreeing on the rules.{approved.length > 0 && ` Approved by ${listNames(approved.map((m) => m.name))}.`}
          {waitingFor.length > 0 && ` Waiting for ${listNames(waitingFor.map((m) => m.name))}.`}
        </p>
      )}
      {mine && workspace.status !== "ready" && !invitation && (
        <button className="ghost small" onClick={fetchInvitation}>
          <Copy size={13} /> Show the invitation again
        </button>
      )}
      {invitation && <TextToSend text={invitation} file={`${workspace.channel}.invitation.txt`} label="The invitation" />}
    </li>
  );
}

/** What a pasted card says, checked by the server as soon as it is pasted. */
function PastedCard({ value, onChange, onRemove, onChecked }: { value: string; onChange: (text: string) => void; onRemove?: () => void; onChecked: (card: CardView | null) => void }) {
  const [card, setCard] = useState<CardView | null>(null);
  const [reach, setReach] = useState<Reach | null | undefined>(undefined);
  const [error, setError] = useState("");
  const noted = useRef(onChecked);
  noted.current = onChecked;

  useEffect(() => {
    setCard(null);
    setReach(undefined);
    setError("");
    noted.current(null);
    if (!value.trim()) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      account.checkCard(value).then(
        (found) => {
          if (stale) return;
          setCard(found);
          const usable = found.known !== "self" && found.known !== "different";
          noted.current(usable ? found : null);
          // The node itself tries their addresses: it is the node that will have to reach them.
          if (usable) {
            account.reachCard(value).then(
              (tried) => !stale && setReach(tried),
              () => !stale && setReach(null),
            );
          }
        },
        (err) => !stale && setError(messageOf(err, "That card could not be read.")),
      );
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [value]);

  return (
    <div className="pasted">
      <div className="pasted-box">
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} placeholder="fabric-chat-card:…" aria-label="Another company's card" spellCheck={false} />
        {onRemove && (
          <button type="button" className="icon" onClick={onRemove} aria-label="Remove this company">
            <X size={16} />
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {card && (
        <div className={`card-seen${card.known === "self" || card.known === "different" ? " bad" : ""}`} style={{ "--org": card.color } as CSSProperties}>
          <Avatar name={card.name} color={card.color} size={30} />
          <div>
            <b>{card.name}</b> <span className="mono dim small">{card.id}</span>
            <p className="small">
              <span className="dim">Fingerprint </span>
              <Fingerprint value={card.fingerprint} />
            </p>
            {card.known === "new" && <p className="dim small">New to this server. Read the fingerprint to them, by phone or in person, before you rely on it.</p>}
            {card.known === "same" && <p className="dim small">Already known to this server, with the same certificate.</p>}
            {(card.known === "new" || card.known === "same") && <ReachLine reach={reach} name={card.name} />}
            {card.known === "self" && (
              <p className="error">
                <TriangleAlert size={13} /> This is your own company's card. Paste the other company's.
              </p>
            )}
            {card.known === "different" && (
              <p className="error">
                <TriangleAlert size={13} /> This server already knows {card.id} under a different certificate. Do not use this card until you have asked them why.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StartForm({ onMade, onCancel }: { onMade: (view: CompaniesView, channel: string, invitation: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [texts, setTexts] = useState<string[]>([""]);
  const [cards, setCards] = useState<(CardView | null)[]>([null]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = name.trim() !== "" && cards.length > 0 && cards.every((c) => c !== null) && new Set(cards.map((c) => c?.id)).size === cards.length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const done = await account.startWorkspace(name.trim(), texts);
      onMade(done, done.channel, done.invitation);
    } catch (err) {
      setError(messageOf(err, "The workspace could not be started."));
      setBusy(false);
    }
  };

  return (
    <form className="form add-member-form" onSubmit={submit}>
      <label>
        Name of the workspace
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="for example: Aster and Dune" maxLength={40} required autoFocus />
      </label>
      <fieldset>
        <legend>The card of each other company</legend>
        {texts.map((text, index) => (
          <PastedCard
            key={index}
            value={text}
            onChange={(next) => setTexts((was) => was.map((t, i) => (i === index ? next : t)))}
            onChecked={(card) => setCards((was) => was.map((c, i) => (i === index ? card : c)))}
            onRemove={
              texts.length > 1
                ? () => {
                    setTexts((was) => was.filter((_, i) => i !== index));
                    setCards((was) => was.filter((_, i) => i !== index));
                  }
                : undefined
            }
          />
        ))}
        {texts.length < 7 && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setTexts((was) => [...was, ""]);
              setCards((was) => [...was, null]);
            }}
          >
            <Plus size={14} /> Add another company
          </button>
        )}
      </fieldset>
      <p className="dim small">
        Every company named here will hold a full copy of the workspace, and the list cannot be changed afterwards. Messages go through while more than half of them are running.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={!ready || busy}>
          {busy ? "Making the first block…" : "Start the workspace"}
        </button>
      </div>
    </form>
  );
}

function AcceptForm({ onJoined, onCancel }: { onJoined: (view: CompaniesView) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [seen, setSeen] = useState<InvitationView | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const run = async (step: "check" | "accept") => {
    if (busy || !text.trim()) return;
    setBusy(step);
    setError("");
    try {
      if (step === "check") setSeen(await account.checkInvitation(text));
      else onJoined(await account.acceptInvitation(text));
    } catch (err) {
      setError(messageOf(err, "That did not work."));
      if (step === "check") setSeen(null);
    } finally {
      setBusy("");
    }
  };
  const starter = seen?.members.find((m) => m.id === seen.createdBy);

  return (
    <form
      className="form add-member-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(seen ? "accept" : "check");
      }}
    >
      <label>
        The invitation you were sent
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSeen(null);
          }}
          rows={4}
          placeholder="fabric-chat-invitation:…"
          spellCheck={false}
          autoFocus
        />
      </label>
      {seen && (
        <div className="invited">
          <p>
            <b>{seen.name}</b>
            {starter && <span className="dim"> · started by {starter.name}</span>}
          </p>
          <p className="dim small">Your node has checked that the workspace's first block says exactly this: these companies, each with one vote, and no others.</p>
          <ul>
            {seen.members.map((m) => (
              <li key={m.id} style={{ "--org": m.color } as CSSProperties}>
                <Avatar name={m.name} color={m.color} size={26} />
                <div>
                  <b>{m.name}</b> <span className="mono dim small">{m.id}</span>
                  {m.self ? <span className="tag">your company</span> : m.known === "new" ? <span className="tag wait">new to this server</span> : null}
                  <p className="small">
                    <Fingerprint value={m.fingerprint} />
                  </p>
                  {!m.self && <ReachLine reach={m.reach ?? null} name={m.name} />}
                </div>
              </li>
            ))}
          </ul>
          {seen.joined ? (
            <p className="good small">Your company is on this workspace already.</p>
          ) : (
            <p className="dim small">Before you accept, check each other company's fingerprint with them. Every company listed will hold a full copy of what is said here.</p>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        {seen && !seen.joined ? (
          <button className="primary" disabled={!!busy}>
            {busy ? "Joining…" : "Accept and join"}
          </button>
        ) : (
          <button className="primary" disabled={!!busy || !text.trim() || !!seen?.joined}>
            {busy ? "Checking…" : "Check it"}
          </button>
        )}
      </div>
    </form>
  );
}
