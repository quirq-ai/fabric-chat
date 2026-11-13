// Small parts used all over: the network's facts, avatars, storage dots, hashes, dialogs.
import { createContext, useContext, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import type { NetworkInfo, Org, Scope, Workspace } from "./types";

/* ------------------------------------------------------------------ the network's facts */

export interface Net {
  info: NetworkInfo;
  org(code: string): Org;
  orgOfMsp(msp: string): Org | undefined;
  /** The company a person such as alice@AsterMSP works at. */
  orgOfUser(userId: string): Org | undefined;
  workspace(channel: string): Workspace | undefined;
}

export function makeNet(info: NetworkInfo): Net {
  const byCode = new Map(info.orgs.map((o) => [o.code, o]));
  const byMsp = new Map(info.orgs.map((o) => [o.msp, o]));
  return {
    info,
    org: (code) => byCode.get(code) ?? { code, name: code, color: "#888", msp: "", peer: "", orderer: "", ca: "", chaincode: "", couchdb: "" },
    orgOfMsp: (msp) => byMsp.get(msp),
    orgOfUser: (userId) => byMsp.get(userId.split("@")[1] ?? ""),
    workspace: (channel) => info.workspaces.find((w) => w.channel === channel),
  };
}

export const NetContext = createContext<Net | null>(null);

export function useNet(): Net {
  const net = useContext(NetContext);
  if (!net) throw new Error("The network's facts are not loaded yet.");
  return net;
}

/* ------------------------------------------------------------------ words */

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "Birch & Co's", "Aster Labs'". */
export const owned = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export const clock = (iso: string) => (iso ? timeFormat.format(new Date(iso)) : "");

/** Hours and minutes only, to fit the narrow margin beside a follow-on message. */
export function shortClock(iso: string): string {
  if (!iso) return "";
  const parts = timeFormat.formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")}`;
}
export const fullTime = (iso: string) => (iso ? fullFormat.format(new Date(iso)) : "");

export function dayOf(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFormat.format(date);
}

export const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`);

/**
 * What a scope means, in words. `membersOnly` is true for a conversation that has a member list.
 * A members-only conversation in the public scope gets a warning: the app hides it from
 * non-members, but every company's node still stores it.
 */
export function scopeWords(net: Net, workspace: Workspace, scope: Scope, membersOnly: boolean) {
  const holders = scope.orgs.map((code) => net.org(code).name);
  const outsiders = workspace.orgs.filter((code) => !scope.orgs.includes(code)).map((code) => net.org(code).name);
  if (workspace.orgs.length === 1) {
    // A company's own workspace: no other company holds any part of it, so the only question is
    // who inside the company can read a conversation.
    const only = holders[0];
    if (scope.kind === "public") {
      return {
        short: `Kept by ${only}`,
        long: `${only} keeps this conversation on its own node, and no other company holds a copy. Everyone at ${only} can read it. Each message is written into a block in the clear, so the earlier versions of an edited message stay on the ledger.`,
        send: `Everyone at ${only} can read what you post here.`,
        warn: false,
        holders,
        outsiders,
      };
    }
    return {
      short: "Members only",
      long: `Only the people in this conversation can read it. ${only} keeps the text in its node's private store, and the blocks carry only a hash of each message, so a deleted message is really gone. Whoever runs the company's node can still read what it stores.`,
      send: "Only the people in this conversation can read it.",
      warn: false,
      holders,
      outsiders,
    };
  }
  const everyone = workspace.orgs.length === 2 ? "both companies" : `all ${workspace.orgs.length} companies`;
  if (scope.kind === "public") {
    return {
      short: `Kept by ${everyone}`,
      long: membersOnly
        ? `The app shows this conversation to its members only. But no smaller scope covers their companies, so the node of every company in the workspace stores the text, and it is written into the blocks in the clear. Treat it as readable by ${listNames(holders)}.`
        : `Every company in this workspace keeps a full copy on its own node: ${listNames(holders)}. Each message is written into a block in the clear.`,
      send: membersOnly ? `Members only in the app, but ${everyone} store the text.` : `${title(everyone)} in this workspace store what you post here.`,
      warn: membersOnly,
      holders,
      outsiders,
    };
  }
  const rest = outsiders.length ? `${listNames(outsiders)} ${outsiders.length === 1 ? "receives" : "receive"} only a hash of each message: proof that it exists and has not changed, without the words. The orderers see only that hash too.` : "";
  return {
    short: `Kept by ${listNames(holders)} only`,
    long: `Only the ${holders.length === 1 ? "node" : "nodes"} of ${listNames(holders)} ${holders.length === 1 ? "stores" : "store"} the text. ${rest}`,
    send: `Only ${listNames(holders)} ${holders.length === 1 ? "stores" : "store"} the text. ${outsiders.length ? `${listNames(outsiders)} ${outsiders.length === 1 ? "gets" : "get"} a hash.` : ""}`,
    warn: false,
    holders,
    outsiders,
  };
}

const title = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/* ------------------------------------------------------------------ parts */

export function Avatar({ name, color, size = 34, title: hint }: { name: string; color: string; size?: number; title?: string }) {
  return (
    <span className="avatar" style={{ "--org": color, width: size, height: size, fontSize: Math.round(size * 0.38) } as CSSProperties} title={hint} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/**
 * One dot for each company in the workspace. A filled dot means that company's node stores the
 * text; a hollow one means it holds only hashes.
 */
export function StorageDots({ workspace, holders, label = true }: { workspace: Workspace; holders: string[]; label?: boolean }) {
  const net = useNet();
  const names = holders.map((code) => net.org(code).name);
  const hint = `Stored by ${listNames(names)}${holders.length < workspace.orgs.length ? ". The others hold only hashes." : ""}`;
  return (
    <span className="dots" title={label ? hint : undefined} role="img" aria-label={hint}>
      {workspace.orgs.map((code) => (
        <i key={code} className={holders.includes(code) ? "dot on" : "dot"} style={{ "--org": net.org(code).color } as CSSProperties} />
      ))}
    </span>
  );
}

/** A long hash, shortened in the middle. The full value is in the tooltip. */
export function Hash({ value, head = 8, tail = 6 }: { value: string; head?: number; tail?: number }) {
  if (!value) return <span className="mono dim">none</span>;
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  return (
    <span className="mono" title={value}>
      {short}
    </span>
  );
}

export function OrgChip({ org }: { org: Org }) {
  return (
    <span className="orgchip" style={{ "--org": org.color } as CSSProperties}>
      {org.name}
    </span>
  );
}

export function Modal({ title: heading, onClose, children, width = 520 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("input, textarea, button.primary")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={heading} style={{ maxWidth: width }} ref={box}>
        <header>
          <h2>{heading}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Keeps the newest value of something in a ref, for handlers that outlive a render. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Reads and writes a small JSON value in this browser's storage. A failure is ignored. */
export const stored = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage is a convenience here, nothing more.
    }
  },
};

export const REACTIONS: { code: string; glyph: string; label: string }[] = [
  { code: "thumbsup", glyph: "👍", label: "Thumbs up" },
  { code: "tada", glyph: "🎉", label: "Celebrate" },
  { code: "eyes", glyph: "👀", label: "Looking" },
  { code: "check", glyph: "✅", label: "Done" },
  { code: "heart", glyph: "❤️", label: "Heart" },
];

export const glyphOf = (code: string) => REACTIONS.find((r) => r.code === code)?.glyph ?? `:${code}:`;
