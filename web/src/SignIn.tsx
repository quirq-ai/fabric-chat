// The first screen: choose who you are. There are no passwords in this demo. What you choose is a
// real identity all the same: a certificate that person's company signed, with its own key.
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { BadgeCheck, CircleHelp, Columns3, UserPlus } from "lucide-react";
import { ApiError, api, type Enrolment } from "./api";
import { Avatar, listNames, owned, useNet } from "./bits";
import { Guide } from "./Guide";
import type { Org, Status } from "./types";

export function SignIn({ onPick, onCompare, onChanged }: { onPick: (id: string) => void; onCompare: (panes: string[]) => void; onChanged: () => void }) {
  const net = useNet();
  const [status, setStatus] = useState<Status | null>(null);
  const [guide, setGuide] = useState(false);

  useEffect(() => {
    api.status().then(setStatus, () => setStatus(null));
  }, []);

  const firstOfEach = net.info.orgs.map((org) => net.info.people.find((p) => p.org === org.code)?.id).filter((id): id is string => !!id);

  return (
    <div className="signin">
      <header className="signin-head">
        <div className="logo" aria-hidden="true">
          {net.info.orgs.map((org) => (
            <i key={org.code} style={{ background: org.color }} />
          ))}
        </div>
        <h1>Fabric Chat</h1>
        <p>
          A team chat with no central server. {listNames(net.info.orgs.map((o) => o.name))} each run their own nodes of a Hyperledger Fabric {net.info.fabric} network, and the ledger they share holds every message.
        </p>
      </header>

      <h2 className="signin-prompt">Who are you?</h2>
      <div className="companies">
        {net.info.orgs.map((org) => (
          <Company key={org.code} org={org} onPick={onPick} onChanged={onChanged} />
        ))}
      </div>

      <div className="signin-actions">
        <button className="ghost" onClick={() => onCompare(firstOfEach)} disabled={firstOfEach.length < 2}>
          <Columns3 size={16} /> Open three people side by side
        </button>
        <button className="ghost" onClick={() => setGuide(true)}>
          <CircleHelp size={16} /> How it works
        </button>
      </div>

      <footer className="signin-foot">
        {net.info.workspaces.map((w) => {
          const rows = status?.ledgers.filter((l) => l.channel === w.channel && l.onChannel) ?? [];
          const agree = rows.length > 0 && rows.every((r) => r.tip === rows[0].tip && r.tip !== "");
          return (
            <span key={w.channel} className="ledger-line">
              <b>{w.name}</b> · channel <code>{w.channel}</code> · {listNames(w.orgs.map((code) => net.org(code).name))}
              {rows.length > 0 && (
                <em className={agree ? "good" : "warn"}>
                  {agree ? ` · ${rows.length} peers agree on ${rows[0].height} blocks` : " · peers are catching up"}
                </em>
              )}
            </span>
          );
        })}
      </footer>
      {guide && <Guide onClose={() => setGuide(false)} />}
    </div>
  );
}

function Company({ org, onPick, onChanged }: { org: Org; onPick: (id: string) => void; onChanged: () => void }) {
  const net = useNet();
  const [adding, setAdding] = useState(false);
  const staff = net.info.people.filter((p) => p.org === org.code);
  return (
    <section className="company" style={{ "--org": org.color } as CSSProperties}>
      <header>
        <h3>{org.name}</h3>
        <p className="mono">{org.msp}</p>
      </header>
      <ul>
        {staff.map((person) => (
          <li key={person.id}>
            <button className="person" onClick={() => onPick(person.id)}>
              <Avatar name={person.name} color={org.color} size={38} />
              <span>
                <b>{person.name}</b>
                <small>{person.title || person.id}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <AddPerson org={org} onDone={onChanged} onPick={onPick} onCancel={() => setAdding(false)} />
      ) : (
        <button className="add" onClick={() => setAdding(true)}>
          <UserPlus size={15} /> Add a person
        </button>
      )}
      <p className="nodes">
        Runs <code>{org.peer.split(".")[0]}</code>, an orderer and the CA <code>{org.ca}</code>
      </p>
    </section>
  );
}

/** Adding a person is an enrolment: the company's CA signs a certificate for a new key. */
function AddPerson({ org, onDone, onPick, onCancel }: { org: Org; onDone: () => void; onPick: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Enrolment | null>(null);
  const handle = name.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9._-]/g, "") ?? "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!handle || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.enrol({ org: org.code, handle, name: name.trim(), title: title.trim() });
      setDone(result);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="enrolled">
        <p>
          <BadgeCheck size={16} /> <b>{done.person.name}</b> now has a certificate.
        </p>
        <dl>
          <dt>Signed by</dt>
          <dd className="mono">{done.certificate.issuer.CN}</dd>
          <dt>Name on it</dt>
          <dd className="mono">
            CN={done.certificate.subject.CN}, OU={done.certificate.subject.OU}
          </dd>
          <dt>Joined</dt>
          <dd>{done.joined.map((j) => `${j.channel} (block ${j.receipt.block})`).join(", ")}</dd>
        </dl>
        <button className="primary" onClick={() => onPick(done.person.id)}>
          Continue as {done.person.name.split(" ")[0]}
        </button>
      </div>
    );
  }
  return (
    <form className="add-form" onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana Okafor" maxLength={40} required />
      </label>
      <label>
        Job title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" maxLength={40} />
      </label>
      <p className="dim">
        {owned(org.name)} CA will sign a certificate for <code>{handle || "…"}</code>. On the ledger they will be <code>{handle || "…"}@{org.msp}</code>.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={!handle || busy}>
          {busy ? "Enrolling…" : "Enrol"}
        </button>
      </div>
    </form>
  );
}
