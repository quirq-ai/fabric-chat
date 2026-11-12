import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { NetContext, makeNet, type Net } from "./bits";
import { Chat } from "./Chat";
import { Compare } from "./Compare";
import { hrefOf, readRoute, type Route } from "./route";
import { SignIn } from "./SignIn";

export function App() {
  const [net, setNet] = useState<Net | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);

  const load = useCallback(() => {
    api
      .network()
      .then((info) => {
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
            Start it from the <code>fabric-chat</code> folder with <code>npm run net:up</code>, or resume a stopped one with <code>npm run net:start</code>.
          </p>
          <button className="primary" onClick={load}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!net) return <div className="splash dim">Reading the network…</div>;

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
