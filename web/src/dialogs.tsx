// The two dialogs of the chat screen: starting a conversation, and looking at your own identity.
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { Copy, Fingerprint, LogOut, TriangleAlert } from "lucide-react";
import { ApiError, api } from "./api";
import { Avatar, Hash, Modal, OrgChip, StorageDots, fullTime, owned, scopeWords, useNet } from "./bits";
import { useChat } from "./chatctx";
import type { Conversation, Receipt, Scope } from "./types";

/* ------------------------------------------------------------------ a new channel or direct message */

interface NewProps {
  kind: "channel" | "dm";
  onClose: () => void;
  onCreated: (conversation: Conversation, receipt: Receipt | null) => void;
}

export function NewConversation({ kind, onClose, onCreated }: NewProps) {
  const net = useNet();
  const chat = useChat();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [open, setOpen] = useState(kind === "channel");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const others = (chat.overview?.people ?? []).filter((p) => p.id !== chat.user);
  const membersOnly = kind === "dm" || !open;

  // The same rule the server applies: the smallest scope that covers everyone's company.
  const scope = useMemo<Scope | undefined>(() => {
    if (!membersOnly) return chat.workspace.scopes.find((s) => s.kind === "public");
    const companies = new Set([chat.me.org, ...picked.map((id) => chat.orgOf(id).code)]);
    return chat.workspace.scopes.filter((s) => [...companies].every((code) => s.orgs.includes(code))).sort((a, b) => a.orgs.length - b.orgs.length)[0];
  }, [membersOnly, picked, chat]);
  const words = scope ? scopeWords(net, chat.workspace, scope, membersOnly) : null;

  const ready = kind === "dm" ? picked.length > 0 : name.trim() !== "";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const made = await api.create(chat.user, chat.ws, { kind, name: name.trim(), topic: topic.trim(), members: membersOnly ? picked : [], open: !membersOnly });
      onCreated(made.conversation, made.receipt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "It could not be created.");
      setBusy(false);
    }
  };

  return (
    <Modal title={kind === "channel" ? "New channel" : "New direct message"} onClose={onClose} width={560}>
      <form className="form" onSubmit={submit}>
        {kind === "channel" && (
          <>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="for example: q1-planning" maxLength={40} />
            </label>
            <label>
              What it is for
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Optional" maxLength={120} />
            </label>
            <fieldset className="choice">
              <legend>Who can read it</legend>
              <label>
                <input type="radio" checked={open} onChange={() => setOpen(true)} /> Everyone in {chat.workspace.name}
              </label>
              <label>
                <input type="radio" checked={!open} onChange={() => setOpen(false)} /> Only the people I choose
              </label>
            </fieldset>
          </>
        )}

        {membersOnly && (
          <fieldset className="people">
            <legend>{kind === "dm" ? "With" : "People"}</legend>
            {chat.workspace.orgs.map((code) => {
              const org = net.org(code);
              const staff = others.filter((p) => chat.orgOf(p.id).code === code);
              if (staff.length === 0) return null;
              return (
                <div key={code} className="people-group" style={{ "--org": org.color } as CSSProperties}>
                  <h4>{org.name}</h4>
                  {staff.map((p) => (
                    <label key={p.id} className={picked.includes(p.id) ? "on" : ""}>
                      <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((was) => (e.target.checked ? [...was, p.id] : was.filter((id) => id !== p.id)))} />
                      <Avatar name={p.name} color={org.color} size={24} />
                      <span>
                        {p.name}
                        {p.title && <small>{p.title}</small>}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}
          </fieldset>
        )}

        {/* Stays in view while the list of people scrolls: where it will be kept is the point of this dialog. */}
        <div className="form-foot">
          {scope && words && (
            <div className={`placement${words.warn ? " warn" : ""}`}>
              <p className="placement-head">
                <StorageDots workspace={chat.workspace} holders={scope.orgs} label={false} />
                <b>{words.short}</b>
                {words.warn && <TriangleAlert size={14} />}
              </p>
              <p>{words.long}</p>
              {membersOnly && !words.warn && <p className="dim small">The app picks the smallest scope that covers everyone's company. Add someone from another company and it widens.</p>}
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <div className="row end">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={!ready || busy}>
              {busy ? "Writing to the ledger…" : kind === "channel" ? "Create channel" : "Open"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ who you are on the ledger */

export function IdentityCard({ onClose, onSignOut }: { onClose: () => void; onSignOut: () => void }) {
  const net = useNet();
  const chat = useChat();
  const { me } = chat;
  const org = net.org(me.org);
  const cert = me.certificate;
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Your identity" onClose={onClose} width={560}>
      <div className="identity">
        <div className="identity-head">
          <Avatar name={chat.nameOf(me.id)} color={org.color} size={52} />
          <div>
            <h3>{chat.nameOf(me.id)}</h3>
            <p>
              {chat.titleOf(me.id) || "Member"} · <OrgChip org={org} />
            </p>
          </div>
        </div>
        <p>
          On this network you are not a row in a user table. You are a <b>certificate</b> that {owned(org.name)} certificate authority signed, and the private key that goes with it. Every message you send is signed with that key,
          and each peer checks the signature before it runs the chaincode.
        </p>
        <dl className="facts">
          <dt>Ledger ID</dt>
          <dd className="mono">{me.asTheLedgerSeesMe?.id ?? me.id}</dd>
          <dt>Name on it</dt>
          <dd className="mono">
            CN={cert.subject.CN} · OU={cert.subject.OU}
          </dd>
          <dt>Signed by</dt>
          <dd className="mono">{cert.issuer.CN}</dd>
          <dt>Organisation</dt>
          <dd className="mono">{me.msp}</dd>
          <dt>Key</dt>
          <dd className="mono">{cert.keyType}</dd>
          <dt>Valid</dt>
          <dd>
            {fullTime(cert.validFrom)} to {fullTime(cert.validTo)}
          </dd>
          <dt>
            <Fingerprint size={13} /> SHA-256
          </dt>
          <dd>
            <Hash value={cert.fingerprint.replace(/:/g, "").toLowerCase()} head={16} tail={12} />
          </dd>
        </dl>
        <p className="dim small">
          "Ledger ID" is what the chaincode itself reports when asked who is calling. It reads the name and the organisation from the certificate, so nobody can post as you by typing your name.
        </p>
        <div className="row end">
          <button
            className="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(cert.pem).then(() => setCopied(true));
            }}
          >
            <Copy size={15} /> {copied ? "Copied" : "Copy certificate"}
          </button>
          <button className="ghost" onClick={onSignOut}>
            <LogOut size={15} /> Switch person
          </button>
        </div>
      </div>
    </Modal>
  );
}
