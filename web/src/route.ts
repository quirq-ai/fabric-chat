// Where the page is, kept in the address so it survives a reload and can sit in a frame.
//   /                                       choose who you are
//   /?as=alice@AsterMSP&ws=commons&c=public/general   the chat, as one person
//   /?view=compare&panes=alice@AsterMSP,bob@BirchMSP  several people side by side
export interface Route {
  as: string;
  ws: string;
  /** The open conversation, as "scope/id". */
  conv: string;
  view: string;
  embed: boolean;
  panes: string[];
}

export function readRoute(): Route {
  const query = new URLSearchParams(window.location.search);
  return {
    as: query.get("as") ?? "",
    ws: query.get("ws") ?? "",
    conv: query.get("c") ?? "",
    view: query.get("view") ?? "",
    embed: query.get("embed") === "1",
    panes: (query.get("panes") ?? "").split(",").filter(Boolean),
  };
}

export function hrefOf(route: Partial<Route>): string {
  const query = new URLSearchParams();
  if (route.view) query.set("view", route.view);
  if (route.panes?.length) query.set("panes", route.panes.join(","));
  if (route.as) query.set("as", route.as);
  if (route.ws) query.set("ws", route.ws);
  if (route.conv) query.set("c", route.conv);
  if (route.embed) query.set("embed", "1");
  const text = query.toString().replace(/%40/g, "@").replace(/%2F/g, "/").replace(/%2C/g, ",");
  return text ? `/?${text}` : "/";
}

/** Changes the address without adding a step to the Back button. */
export function noteRoute(route: Partial<Route>): void {
  const next = hrefOf(route);
  if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, "", next);
}
