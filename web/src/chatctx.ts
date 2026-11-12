// What every part of the chat screen needs to know: who is signed in, which workspace is open, and
// how to turn an ID such as bob@BirchMSP into a name and a company.
import { createContext, useContext } from "react";
import type { Conversation, Me, Org, Overview, Scope, Workspace } from "./types";

export interface ChatCtx {
  user: string;
  me: Me;
  ws: string;
  workspace: Workspace;
  overview: Overview | null;
  nameOf(id: string): string;
  titleOf(id: string): string;
  orgOf(id: string): Org;
  scopeOf(name: string): Scope | undefined;
  /** A conversation's title: its name, or for a direct message the other people in it. */
  labelOf(conv: Conversation): string;
}

export const ChatContext = createContext<ChatCtx | null>(null);

export function useChat(): ChatCtx {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("Not inside the chat screen.");
  return ctx;
}

export interface Active {
  scope: string;
  id: string;
}

/** What the ledger panel is showing: a transaction, and the message it belongs to if that is known. */
export interface Selection {
  txId: string;
  message?: { scope: string; convId: string; msgId: string };
}

export const keyOf = (conv: Active) => `${conv.scope}/${conv.id}`;

export function parseConv(text: string): Active | null {
  const at = text.indexOf("/");
  return at > 0 && at < text.length - 1 ? { scope: text.slice(0, at), id: text.slice(at + 1) } : null;
}
