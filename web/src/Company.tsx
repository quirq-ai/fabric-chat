// What a company's own server shows that the sandbox does not: a sign-in form, the page behind an
// invitation link, and the list of people an administrator looks after.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { BadgeCheck, Copy, Link2, ShieldCheck, UserPlus } from "lucide-react";
import { ApiError, account, type Added } from "./api";
import { Avatar, Modal, fullTime, owned, useNet } from "./bits";
import { useChat } from "./chatctx";
import type { Member, NetworkInfo, Role, SessionUser } from "./types";

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/* ------------------------------------------------------------------ the frame around both first screens */

function Gate({ info, children }: { info: NetworkInfo; children: ReactNode }) {
  const company = info.company!;
  return (
    <div className="gate" style={{ "--org": company.color } as CSSProperties}>
      <main className="gate-card">
        <Avatar name={company.name} color={company.color} size={46} />
        {children}
      </main>
      <p className="gate-foot">
        {company.name} runs this chat on its own Hyperledger Fabric {info.fabric} node. Every message is a transaction, signed with its author's own key.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ signing in */

export function CompanySignIn({ info, onSignedIn }: { info: NetworkInfo; onSignedIn: (user: SessionUser) => void }) {
  const company = info.company!;
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Someone may type their whole ID, dana@dune.example. The handle is the part before the @.
      const done = await account.signIn(handle.trim().toLowerCase().split("@")[0], password);
      onSignedIn(done.user);
    } catch (err) {
      setError(messageOf(err, "That did not work."));
      setBusy(false);
    }
  };

  return (
    <Gate info={info}>
      <h1>Sign in to {company.name}</h1>
      <form className="form" onSubmit={submit}>
        <label>
          Handle
          <input value={handle} onChange={(e) => setHandle(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="for example: dana" maxLength={100} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={200} required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !handle.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="dim small">New here, or forgot your password? Ask an administrator at {company.name} for a link.</p>
    </Gate>
  );
}

/* ------------------------------------------------------------------ the page behind an invitation link */

interface Invited {
  handle: string;
  name: string;
  id: string;
  first: boolean;
}

export function AcceptInvite({ info, token, onSignedIn, onLeave }: { info: NetworkInfo; token: string; onSignedIn: (user: SessionUser) => void; onLeave: () => void }) {
  const company = info.company!;
  const [who, setWho] = useState<Invited | null>(null);
  const [problem, setProblem] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let stale = false;
    account.invite(token).then(
      (found) => !stale && setWho(found),
      (err) => !stale && setProblem(messageOf(err, "This link could not be checked.")),
    );
    return () => {
      stale = true;
    };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== again) {
      setError("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const done = await account.accept(token, password);
      onSignedIn(done.user);
    } catch (err) {
      setError(messageOf(err, "That did not work."));
      setBusy(false);
    }
  };

  if (problem) {
    return (
      <Gate info={info}>
        <h1>This link cannot be used</h1>
        <p>{problem}</p>
        <button className="primary" onClick={onLeave}>
          Go to sign-in
        </button>
      </Gate>
    );
  }
  if (!who) {
    return (
      <Gate info={info}>
        <p className="dim">Checking the link…</p>
      </Gate>
    );
  }
  return (
    <Gate info={info}>
      <h1>{who.first ? `Welcome, ${who.name.split(" ")[0]}` : "Choose a new password"}</h1>
      <p>
        {who.first ? `${company.name} has added you to its chat. ` : ""}Your ID is <code>{who.id}</code>. Choose {who.first ? "a" : "the"} password you will sign in with.
      </p>
      <form className="form" onSubmit={submit}>
        {/* Lets a password manager file the new password under the right name. */}
        <input type="text" value={who.handle} autoComplete="username" readOnly hidden />
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={200} required autoFocus />
        </label>
        <label>
          The same password again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" maxLength={200} required />
        </label>
        <p className="dim small">At least 10 characters. Nobody else sees it, your administrator included.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || password.length < 10 || !again}>
          {busy ? "Saving…" : who.first ? "Start chatting" : "Save and sign in"}
        </button>
      </form>
    </Gate>
  );
}

/* ------------------------------------------------------------------ people, for an administrator */

export function PeopleDialog({ onClose }: { onClose: () => void }) {
  const net = useNet();
  const chat = useChat();
  const company = net.info.company!;
  const [people, setPeople] = useState<Member[] | null>(null);
  const [fresh, setFresh] = useState<Added | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => account.people().then((found) => setPeople(found.people), (err) => setError(messageOf(err, "The list could not be read."))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (handle: string, run: () => Promise<Added | { person: Member }>) => {
    setBusy(handle);
    setError("");
    try {
      const done = await run();
      setFresh("link" in done ? done : null);
      await load();
    } catch (err) {
      setError(messageOf(err, "That did not work."));
    } finally {
      setBusy("");
    }
  };

  const admins = people?.filter((p) => p.role === "admin").length ?? 0;

  return (
    <Modal title={`People at ${company.name}`} onClose={onClose} width={640}>
      <div className="members">
        <p className="dim">
          Adding a person has {owned(company.name)} certificate authority sign them a certificate. You then pass on a one-time link, and they choose their own password.
        </p>

        {fresh && <LinkBox added={fresh} onDone={() => setFresh(null)} />}

        {adding ? (
          <AddPerson
            onCancel={() => setAdding(false)}
            onAdded={(added) => {
              setAdding(false);
              setFresh(added);
              void load();
            }}
          />
        ) : (
          <button className="ghost add-member" onClick={() => setAdding(true)}>
            <UserPlus size={15} /> Add a person
          </button>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!people && !error && <p className="dim">Reading the list…</p>}

        <ul className="member-rows">
          {people?.map((person) => {
            const self = person.id === chat.user;
            const onlyAdmin = person.role === "admin" && admins === 1;
            const other: Role = person.role === "admin" ? "member" : "admin";
            return (
              <li key={person.handle}>
                <Avatar name={person.name} color={company.color} size={34} />
                <div className="member-who">
                  <b>
                    {person.name}
                    {self && <span className="dim"> (you)</span>}
                  </b>
                  <small className="mono">{person.id}</small>
                  <small>
                    {person.title || "No job title"}
                    {person.role === "admin" && (
                      <span className="tag">
                        <ShieldCheck size={11} /> Administrator
                      </span>
                    )}
                    {person.state === "invited" && <span className="tag wait">{person.linkWaiting ? "Has not opened their link yet" : "Their link has run out"}</span>}
                  </small>
                </div>
                <div className="member-acts">
                  {/* Your own password is changed from your identity card, with the current one. */}
                  {!self && (
                    <button className="ghost small" disabled={busy === person.handle} onClick={() => act(person.handle, () => account.newLink(person.handle))} title={person.state === "invited" ? "Make a new invitation link" : "Make a link to choose a new password"}>
                      <Link2 size={13} /> {person.state === "invited" ? "New link" : "Reset password"}
                    </button>
                  )}
                  <button
                    className="ghost small"
                    disabled={busy === person.handle || onlyAdmin}
                    onClick={() => act(person.handle, () => account.setRole(person.handle, other))}
                    title={onlyAdmin ? "The only administrator cannot be made a member" : undefined}
                  >
                    {other === "admin" ? "Make administrator" : "Make member"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="dim small">Removing a person is not built yet. Until it is, a person who leaves keeps a working certificate.</p>
      </div>
    </Modal>
  );
}

function AddPerson({ onAdded, onCancel }: { onAdded: (added: Added) => void; onCancel: () => void }) {
  const net = useNet();
  const company = net.info.company!;
  const [name, setName] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The handle follows the first name until someone types their own.
  const suggested = name.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9._-]/g, "") ?? "";
  const handle = (typed ?? suggested).toLowerCase();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!handle || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      onAdded(await account.add({ handle, name: name.trim(), title: title.trim(), role: admin ? "admin" : "member" }));
    } catch (err) {
      setError(messageOf(err, "They could not be added."));
      setBusy(false);
    }
  };

  return (
    <form className="form add-member-form" onSubmit={submit}>
      <div className="pair">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dev Malik" maxLength={40} required autoFocus />
        </label>
        <label>
          Handle
          <input value={handle} onChange={(e) => setTyped(e.target.value.replace(/[^A-Za-z0-9._-]/g, ""))} placeholder="dev" maxLength={32} autoCapitalize="none" spellCheck={false} required />
        </label>
      </div>
      <label>
        Job title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" maxLength={40} />
      </label>
      <label className="check">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> An administrator, who can add people too
      </label>
      <p className="dim small">
        On the ledger they will be <code>{handle || "…"}@{company.id}</code>. The handle cannot be changed later.
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
        <button className="primary" disabled={!handle || !name.trim() || busy}>
          {busy ? "Asking the certificate authority…" : "Add"}
        </button>
      </div>
    </form>
  );
}

/** The link an administrator passes on. It is shown once: the server keeps only its hash. */
function LinkBox({ added, onDone }: { added: Added; onDone: () => void }) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const first = added.person.state === "invited";

  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(added.link);
      setCopied(true);
    } catch {
      // No clipboard on a plain http page: the link is selected, ready to copy by hand.
    }
  };

  return (
    <section className="link-box">
      <p className="link-head">
        <BadgeCheck size={16} />
        <span>
          <b>{added.person.name}</b> {added.certificate ? "now has a certificate." : first ? "has a new invitation link." : "can choose a new password."}
        </span>
      </p>
      <p>
        Send them this link yourself. It works once, until {fullTime(added.expires)}, and replaces any link made earlier. It is not shown again.
      </p>
      <div className="link-row">
        <input ref={field} value={added.link} readOnly onFocus={(e) => e.target.select()} aria-label={`Link for ${added.person.name}`} />
        <button className="primary" onClick={copy}>
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {added.certificate && (
        <dl className="facts">
          <dt>Ledger ID</dt>
          <dd className="mono">{added.person.id}</dd>
          <dt>Signed by</dt>
          <dd className="mono">{added.certificate.issuer.CN}</dd>
          {added.joined && added.joined.length > 0 && (
            <>
              <dt>Joined</dt>
              <dd>{added.joined.map((j) => `the directory, in block ${j.block}`).join(", ")}</dd>
            </>
          )}
        </dl>
      )}
      <div className="row end">
        <button className="ghost small" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}
