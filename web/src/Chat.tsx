// The chat screen for one signed-in person: workspaces, conversations, the open conversation and
// the ledger panel. It keeps itself current by listening to the blocks the person's own company's
// peer commits.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Blocks, CircleHelp, Hash as HashIcon, Lock, LogOut, Menu, Plus, TriangleAlert, X } from "lucide-react";
import { ApiError, api } from "./api";
import { Avatar, StorageDots, listNames, stored, useLatest, useNet } from "./bits";
import { ChatContext, keyOf, parseConv, type Active, type ChatCtx, type Selection } from "./chatctx";
import { ConversationPane, type PendingPost } from "./Conversation";
import { IdentityCard, NewConversation } from "./dialogs";
import { Guide } from "./Guide";
import { LedgerPanel, type LedgerTab } from "./Ledger";
import { noteRoute } from "./route";
import type { BlockView, Conversation, Me, Message, Overview, Receipt, Thread } from "./types";

interface Props {
  user: string;
  /** True inside the side-by-side view: less chrome, no ledger panel to start with. */
  embed: boolean;
  startWs: string;
  startConv: string;
  onSignOut: () => void;
}

type Dialog = null | "channel" | "dm" | "identity" | "guide";

export function Chat({ user, embed, startWs, startConv, onSignOut }: Props) {
  const net = useNet();
  const [me, setMe] = useState<Me | null>(null);
  const [fatal, setFatal] = useState("");
  const [ws, setWs] = useState(startWs);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [active, setActive] = useState<Active | null>(() => parseConv(startConv));
  const [thread, setThread] = useState<Thread | null>(null);
  const [blocks, setBlocks] = useState<BlockView[]>([]);
  const [live, setLive] = useState(true);
  const [ledgerOpen, setLedgerOpen] = useState(() => !embed && window.innerWidth >= 1180);
  const [tab, setTab] = useState<LedgerTab>("blocks");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const [pending, setPending] = useState<PendingPost[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState("");
  const [stirred, setStirred] = useState<Record<string, boolean>>({});
  const [seen, setSeen] = useState<Record<string, string>>(() => stored.get(`fabchat.seen.${user}`, {}));
  const [menu, setMenu] = useState(false);

  const wsRef = useLatest(ws);
  const activeRef = useLatest(active);
  const workspace = net.workspace(ws);

  const report = useCallback((err: unknown) => {
    setToast(err instanceof ApiError ? err.message : "Something went wrong.");
  }, []);

  /* ---- loading ---- */

  useEffect(() => {
    let stale = false;
    api.me(user).then(
      (mine) => {
        if (stale) return;
        setMe(mine);
        setWs((current) => (mine.workspaces.includes(current) ? current : (mine.workspaces[0] ?? "")));
      },
      (err: ApiError) => !stale && setFatal(err.message),
    );
    return () => {
      stale = true;
    };
  }, [user]);

  const loadOverview = useCallback(async () => {
    const forWs = wsRef.current;
    if (!forWs) return;
    try {
      const next = await api.overview(user, forWs);
      if (wsRef.current === forWs) setOverview(next);
    } catch (err) {
      report(err);
    }
  }, [user, wsRef, report]);

  const loadThread = useCallback(async () => {
    const forWs = wsRef.current;
    const conv = activeRef.current;
    if (!forWs || !conv) return;
    try {
      const next = await api.messages(user, forWs, conv.scope, conv.id);
      const now = activeRef.current;
      if (wsRef.current === forWs && now && keyOf(now) === keyOf(conv)) setThread(next);
    } catch (err) {
      // A conversation that is gone, or that this person may not read, is simply closed.
      if (err instanceof ApiError && [400, 403, 404].includes(err.status)) setActive(null);
      report(err);
    }
  }, [user, wsRef, activeRef, report]);

  const loadBlocks = useCallback(async () => {
    const forWs = wsRef.current;
    if (!forWs) return;
    try {
      const next = await api.blocks(user, forWs, 60);
      if (wsRef.current === forWs) setBlocks(next.blocks);
    } catch (err) {
      report(err);
    }
  }, [user, wsRef, report]);

  useEffect(() => {
    if (!me || !ws) return;
    setOverview(null);
    setBlocks([]);
    void loadOverview();
    void loadBlocks();
  }, [me, ws, loadOverview, loadBlocks]);

  const activeKey = active ? keyOf(active) : "";
  useEffect(() => {
    setThread(null);
    if (me && ws && activeKey) void loadThread();
  }, [me, ws, activeKey, loadThread]);

  // Open #general, or whatever comes first, when nothing valid is open.
  const justMade = useRef("");
  useEffect(() => {
    if (!overview) return;
    if (active && overview.conversations.some((c) => keyOf(c) === keyOf(active))) {
      justMade.current = "";
      return;
    }
    // A conversation made a moment ago may not be in the list yet. Leave it open until it is.
    if (active && justMade.current === keyOf(active)) return;
    const first = overview.conversations.find((c) => c.kind === "channel" && c.name === "general") ?? overview.conversations[0];
    setActive(first ? { scope: first.scope, id: first.id } : null);
  }, [overview, active]);

  useEffect(() => {
    noteRoute({ as: user, ws, conv: activeKey, embed });
  }, [user, ws, activeKey, embed]);

  /* ---- live: one event per block this company's peer commits ---- */

  const refreshSoon = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!me) return;
    const source = new EventSource(`/api/stream?as=${encodeURIComponent(user)}`);
    let first = true;
    const refresh = () => {
      window.clearTimeout(refreshSoon.current);
      refreshSoon.current = window.setTimeout(() => {
        void loadOverview();
        void loadThread();
      }, 60);
    };
    source.addEventListener("hello", () => {
      setLive(true);
      // After a dropped connection, catch up on whatever was missed.
      if (!first) {
        refresh();
        void loadBlocks();
      }
      first = false;
    });
    source.addEventListener("block", (event) => {
      const block = JSON.parse((event as MessageEvent<string>).data) as BlockView;
      if (block.channel !== wsRef.current) {
        setStirred((was) => ({ ...was, [block.channel]: true }));
        return;
      }
      setBlocks((was) => (was.length && block.number <= was[was.length - 1].number ? was : [...was, block].slice(-120)));
      if (block.txs.some((tx) => tx.valid && tx.event?.name === "chat")) refresh();
    });
    source.onerror = () => setLive(false);
    return () => {
      source.close();
      window.clearTimeout(refreshSoon.current);
    };
  }, [me, user, wsRef, loadOverview, loadThread, loadBlocks]);

  /* ---- unread marks, kept in this browser ---- */

  const activeConv = useMemo(() => overview?.conversations.find((c) => active && keyOf(c) === keyOf(active)) ?? null, [overview, active]);
  useEffect(() => {
    if (!activeConv) return;
    const key = `${ws}/${keyOf(activeConv)}`;
    setSeen((was) => {
      if (was[key] === activeConv.lastAt) return was;
      const next = { ...was, [key]: activeConv.lastAt };
      stored.set(`fabchat.seen.${user}`, next);
      return next;
    });
  }, [activeConv, ws, user]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 9000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /* ---- names ---- */

  const ctx = useMemo<ChatCtx | null>(() => {
    if (!me || !workspace) return null;
    const profiles = new Map(overview?.people.map((p) => [p.id, p]) ?? []);
    const roster = new Map(net.info.people.map((p) => [p.id, p]));
    const nameOf = (id: string) => profiles.get(id)?.name ?? roster.get(id)?.name ?? id.split("@")[0];
    return {
      user,
      me,
      ws,
      workspace,
      overview,
      nameOf,
      titleOf: (id) => profiles.get(id)?.title ?? roster.get(id)?.title ?? "",
      orgOf: (id) => net.orgOfUser(id) ?? net.org(me.org),
      scopeOf: (name) => workspace.scopes.find((s) => s.name === name),
      labelOf: (conv) => {
        if (conv.kind === "channel") return conv.name;
        const others = conv.members.filter((id) => id !== user);
        return others.length ? listNames(others.map(nameOf)) : "Just you";
      },
    };
  }, [me, workspace, overview, net, user, ws]);

  /* ---- actions ---- */

  const keep = (receipt: Receipt) => setReceipts((was) => ({ ...was, [receipt.txId]: receipt }));

  const merge = (message: Message) =>
    setThread((was) => {
      if (!was || was.conversation.id !== message.convId) return was;
      const at = was.messages.findIndex((m) => m.id === message.id);
      const messages = at >= 0 ? was.messages.map((m, i) => (i === at ? message : m)) : [...was.messages, message];
      return { ...was, messages };
    });

  const send = async (text: string, retryKey?: string) => {
    if (!active) return;
    const conv = active;
    const key = retryKey ?? `${Date.now()}-${Math.random()}`;
    setPending((was) => [...was.filter((p) => p.key !== key), { key, conv: keyOf(conv), text }]);
    try {
      const done = await api.post(user, ws, conv.scope, conv.id, text);
      keep(done.receipt);
      merge(done.message);
      setPending((was) => was.filter((p) => p.key !== key));
    } catch (err) {
      setPending((was) => was.map((p) => (p.key === key ? { ...p, error: err instanceof ApiError ? err.message : "It was not sent." } : p)));
    }
  };

  const act = async (run: () => Promise<{ receipt: Receipt; message?: Message }>) => {
    try {
      const done = await run();
      keep(done.receipt);
      if (done.message) merge(done.message);
    } catch (err) {
      report(err);
      void loadThread();
    }
  };

  const react = (message: Message, emoji: string, on: boolean) => {
    if (!active) return;
    // Shown at once, and put right by the next block if the ledger disagrees.
    setThread((was) => {
      if (!was) return was;
      const forMessage = { ...(was.reactions[message.id] ?? {}) };
      const people = (forMessage[emoji] ?? []).filter((id) => id !== user);
      if (on) people.push(user);
      if (people.length) forMessage[emoji] = people;
      else delete forMessage[emoji];
      return { ...was, reactions: { ...was.reactions, [message.id]: forMessage } };
    });
    void act(() => api.react(user, ws, active.scope, active.id, message.id, emoji, on));
  };

  const inspect = (selection: Selection) => {
    setSelected(selection);
    setTab("tx");
    setLedgerOpen(true);
  };

  const openConversation = (conv: Active) => {
    setActive(conv);
    setMenu(false);
  };

  const switchWorkspace = (channel: string) => {
    if (channel === ws) return;
    setWs(channel);
    setActive(null);
    setSelected(null);
    setThread(null);
    setStirred((was) => ({ ...was, [channel]: false }));
  };

  /* ---- drawing ---- */

  if (fatal) {
    return (
      <div className="splash">
        <div className="splash-card">
          <h1>That person cannot sign in</h1>
          <p>{fatal}</p>
          <button className="primary" onClick={onSignOut}>
            Choose someone else
          </button>
        </div>
      </div>
    );
  }
  if (!me || !ctx || !workspace) return <div className="splash dim">Signing in as {user}…</div>;

  const myOrg = net.org(me.org);
  const conversations = overview?.conversations ?? [];
  const channels = conversations.filter((c) => c.kind === "channel").sort((a, b) => Number(b.name === "general") - Number(a.name === "general") || a.name.localeCompare(b.name));
  const directs = conversations.filter((c) => c.kind === "dm").sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const unread = (conv: Conversation) => conv.lastBy !== user && conv.lastAt > (seen[`${ws}/${keyOf(conv)}`] ?? "") && (!active || keyOf(conv) !== keyOf(active));
  const myWorkspaces = me.workspaces.map((channel) => net.workspace(channel)).filter((w) => !!w);

  const row = (conv: Conversation) => {
    const scope = ctx.scopeOf(conv.scope);
    const isActive = !!active && keyOf(conv) === keyOf(active);
    return (
      <li key={keyOf(conv)}>
        <button className={`conv${isActive ? " active" : ""}${unread(conv) ? " unread" : ""}`} onClick={() => openConversation({ scope: conv.scope, id: conv.id })}>
          {conv.kind === "channel" ? (
            conv.members.length ? (
              <Lock size={14} className="glyph" />
            ) : (
              <HashIcon size={14} className="glyph" />
            )
          ) : (
            <Avatar name={ctx.labelOf(conv)} color={ctx.orgOf(conv.members.find((id) => id !== user) ?? user).color} size={18} />
          )}
          <span className="conv-name">{ctx.labelOf(conv)}</span>
          {scope && <StorageDots workspace={workspace} holders={scope.orgs} />}
        </button>
      </li>
    );
  };

  return (
    <ChatContext.Provider value={ctx}>
      <div className={`app${embed ? " embed" : ""}${ledgerOpen ? " with-ledger" : ""}${menu ? " menu-open" : ""}`} style={{ "--me": myOrg.color } as CSSProperties}>
        {!embed && (
          <nav className="rail" aria-label="Workspaces">
            {myWorkspaces.map((w) => (
              <button key={w.channel} className={`ws${w.channel === ws ? " active" : ""}`} onClick={() => switchWorkspace(w.channel)} title={`${w.name}: Fabric channel "${w.channel}", shared by ${listNames(w.orgs.map((c) => net.org(c).name))}`}>
                {w.name.slice(0, 2)}
                {stirred[w.channel] && w.channel !== ws && <i className="stir" />}
              </button>
            ))}
            <span className="rail-gap" />
            <button className="rail-btn" onClick={() => setDialog("guide")} title="How it works" aria-label="How it works">
              <CircleHelp size={19} />
            </button>
            <button className={`rail-btn${ledgerOpen ? " on" : ""}`} onClick={() => setLedgerOpen((was) => !was)} title="Under the hood: the ledger" aria-label="Show or hide the ledger panel">
              <Blocks size={19} />
            </button>
            <button className="rail-btn" onClick={onSignOut} title="Switch person" aria-label="Switch person">
              <LogOut size={18} />
            </button>
          </nav>
        )}

        <aside className="sidebar">
          <header className="ws-head">
            {embed && myWorkspaces.length > 1 ? (
              <select value={ws} onChange={(e) => switchWorkspace(e.target.value)} aria-label="Workspace">
                {myWorkspaces.map((w) => (
                  <option key={w.channel} value={w.channel}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : (
              <h2>{workspace.name}</h2>
            )}
            <p>
              <StorageDots workspace={workspace} holders={workspace.orgs} label={false} /> channel <code>{workspace.channel}</code>
            </p>
            <button className="icon close-menu" onClick={() => setMenu(false)} aria-label="Close the list">
              <X size={18} />
            </button>
          </header>

          <div className="lists">
            <section>
              <h3>
                Channels
                <button className="icon" onClick={() => setDialog("channel")} title="New channel" aria-label="New channel">
                  <Plus size={16} />
                </button>
              </h3>
              <ul>{channels.map(row)}</ul>
            </section>
            <section>
              <h3>
                Direct messages
                <button className="icon" onClick={() => setDialog("dm")} title="New direct message" aria-label="New direct message">
                  <Plus size={16} />
                </button>
              </h3>
              <ul>{directs.map(row)}</ul>
              {overview && directs.length === 0 && <p className="none">None yet.</p>}
            </section>
          </div>

          <button className="me" onClick={() => setDialog("identity")} title="Your identity on the ledger">
            <Avatar name={ctx.nameOf(user)} color={myOrg.color} size={34} />
            <span>
              <b>{ctx.nameOf(user)}</b>
              <small>{myOrg.name}</small>
            </span>
            {!live && <TriangleAlert size={15} className="offline" aria-label="Not connected" />}
          </button>
        </aside>

        <main className="main">
          {activeConv && thread && thread.conversation.id === activeConv.id ? (
            <ConversationPane
              conv={activeConv}
              thread={thread}
              pending={pending.filter((p) => active && p.conv === keyOf(active))}
              receipts={receipts}
              selectedTx={ledgerOpen && tab === "tx" ? (selected?.txId ?? "") : ""}
              height={blocks.length ? blocks[blocks.length - 1].number + 1 : 0}
              ledgerOpen={ledgerOpen}
              embed={embed}
              onMenu={() => setMenu(true)}
              onToggleLedger={() => setLedgerOpen((was) => !was)}
              onSend={send}
              onDismiss={(key) => setPending((was) => was.filter((p) => p.key !== key))}
              onEdit={(message, text) => act(() => api.edit(user, ws, activeConv.scope, activeConv.id, message.id, text))}
              onDelete={(message) => act(() => api.remove(user, ws, activeConv.scope, activeConv.id, message.id))}
              onReact={react}
              onInspect={inspect}
              onAddPeople={(members) => act(async () => ({ receipt: (await api.addMembers(user, ws, activeConv.scope, activeConv.id, members)).receipt }))}
            />
          ) : (
            <div className="blank">
              <button className="icon menu-btn" onClick={() => setMenu(true)} aria-label="Show conversations">
                <Menu size={20} />
              </button>
              <p>{overview && conversations.length === 0 ? "No conversations yet. Start one from the list." : "Opening…"}</p>
            </div>
          )}
        </main>

        {ledgerOpen && (
          <LedgerPanel
            tab={tab}
            onTab={setTab}
            blocks={blocks}
            selected={selected}
            receipts={receipts}
            onSelect={inspect}
            onClose={() => setLedgerOpen(false)}
            onProblem={report}
          />
        )}

        {dialog === "guide" && <Guide onClose={() => setDialog(null)} />}
        {dialog === "identity" && <IdentityCard onClose={() => setDialog(null)} onSignOut={onSignOut} />}
        {(dialog === "channel" || dialog === "dm") && (
          <NewConversation
            kind={dialog}
            onClose={() => setDialog(null)}
            onCreated={(conv, receipt) => {
              if (receipt) keep(receipt);
              setDialog(null);
              // Put it in the list now. The block that carries it will bring the list up to date.
              justMade.current = keyOf(conv);
              setOverview((was) => (was && !was.conversations.some((c) => keyOf(c) === keyOf(conv)) ? { ...was, conversations: [...was.conversations, conv] } : was));
              openConversation({ scope: conv.scope, id: conv.id });
            }}
          />
        )}
        {toast && (
          <div className="toast" role="alert">
            <TriangleAlert size={16} />
            <span>{toast}</span>
            <button className="icon" onClick={() => setToast("")} aria-label="Dismiss">
              <X size={15} />
            </button>
          </div>
        )}
      </div>
    </ChatContext.Provider>
  );
}
