import { useCallback, useEffect, useState } from "react";
import { ApiError, SIGNED_OUT, account, api } from "./api";
import { NetContext, makeNet, type Net } from "./bits";
import { Chat } from "./Chat";
import { AcceptInvite, CompanySignIn } from "./Company";
import { Compare } from "./Compare";
import { hrefOf, readRoute, type Route } from "./route";
import { SignIn } from "./SignIn";
import type { SessionUser } from "./types";

export function App() {
  const [net, setNet] = useState<Net | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  // A company's own server only: who is signed in. Undefined until the server has been asked.
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  const load = useCallback(() => {
    api
      .network()
      .then(async (info) => {
        if (info.mode === "company") setUser(info.locked ? null : (await account.session()).user);
        setNet(makeNet(info));
        setProblem(null);
      })
      .catch((err: ApiError) => setProblem(err));
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // The server said the session is over: show the sign-in screen again.
  useEffect(() => {
    window.addEventListener(SIGNED_OUT, load);
    return () => window.removeEventListener(SIGNED_OUT, load);
  }, [load]);

  const go = useCallback((next: Partial<Route>) => {
    window.history.pushState(null, "", hrefOf(next));
    setRoute(readRoute());
  }, []);

  if (problem) {
    return (
      <div className="splash">
        <div className="splash-card">
          <h1>The Fabric network is not answering</h1>
          <p>{problem.message}</p>
          <p className="dim">
            Start it from the <code>fabric-chat</code> folder with <code>npm run net:up</code>, or resume a stopped one with <code>npm run net:start</code>. On a company's own server, run <code>./chat up</code>.
          </p>
          <button className="primary" onClick={load}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!net) return <div className="splash dim">Reading the network…</div>;

  if (net.info.mode === "company") {
    // Signing in changes what the server will tell this browser, so the network's facts are read again.
    const signedIn = () => {
      // An invitation's secret has done its work. It does not stay in the address or the history.
      if (route.invite) window.history.replaceState(null, "", "/");
      setRoute(readRoute());
      setUser(undefined);
      load();
    };
    const signOut = () => {
      void account.signOut().finally(() => {
        window.history.replaceState(null, "", "/");
        setRoute(readRoute());
        load();
      });
    };
    if (route.invite) return <AcceptInvite info={net.info} token={route.invite} onSignedIn={signedIn} onLeave={() => go({})} />;
    if (user === undefined) return <div className="splash dim">Reading the network…</div>;
    if (!user || net.info.locked) return <CompanySignIn info={net.info} onSignedIn={signedIn} />;
    return (
      <NetContext.Provider value={net}>
        <Chat key={user.id} user={user.id} embed={false} startWs={route.ws} startConv={route.conv} onSignOut={signOut} onChanged={load} />
      </NetContext.Provider>
    );
  }

  return (
    <NetContext.Provider value={net}>
      {route.view === "compare" ? (
        <Compare panes={route.panes} onChange={(panes) => go({ view: "compare", panes })} onLeave={() => go({})} />
      ) : route.as ? (
        <Chat key={route.as} user={route.as} embed={route.embed} startWs={route.ws} startConv={route.conv} onSignOut={() => go({})} />
      ) : (
        <SignIn onPick={(id) => go({ as: id })} onCompare={(panes) => go({ view: "compare", panes })} onChanged={load} />
      )}
    </NetContext.Provider>
  );
}
