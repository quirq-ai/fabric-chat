// Several people side by side, each in their own frame. Send a message in one and watch which of
// the others receive it.
import { ArrowLeft, Minus, Plus } from "lucide-react";
import { useNet } from "./bits";
import { hrefOf } from "./route";

export function Compare({ panes, onChange, onLeave }: { panes: string[]; onChange: (panes: string[]) => void; onLeave: () => void }) {
  const net = useNet();
  const everyone = net.info.people;
  const fallback = net.info.orgs.map((org) => everyone.find((p) => p.org === org.code)?.id).filter((id): id is string => !!id);
  const list = (panes.length ? panes : fallback).filter((id) => everyone.some((p) => p.id === id)).slice(0, 4);

  // Each frame gets its own host name. A browser allows only a few open connections to one host,
  // and every pane keeps one open to hear about new blocks.
  const frame = (id: string, index: number) => `${window.location.protocol}//pane${index + 1}.localhost:${window.location.port}${hrefOf({ as: id, embed: true })}`;
  const spare = everyone.find((p) => !list.includes(p.id))?.id;

  return (
    <div className="compare">
      <header>
        <button className="ghost" onClick={onLeave}>
          <ArrowLeft size={16} /> Back
        </button>
        <div>
          <h1>Side by side</h1>
          <p>Each pane is a different person, talking only to their own company's peer. Nothing passes between panes except through the ledger.</p>
        </div>
        <div className="row">
          <button className="ghost" disabled={list.length <= 2} onClick={() => onChange(list.slice(0, -1))} aria-label="Remove a pane">
            <Minus size={16} />
          </button>
          <button className="ghost" disabled={list.length >= 4 || !spare} onClick={() => spare && onChange([...list, spare])} aria-label="Add a pane">
            <Plus size={16} />
          </button>
        </div>
      </header>
      <div className="panes" style={{ gridTemplateColumns: `repeat(${list.length}, minmax(0, 1fr))` }}>
        {list.map((id, index) => {
          const org = net.orgOfUser(id);
          return (
            <section key={`${index}-${id}`} style={{ borderTopColor: org?.color }}>
              <select value={id} onChange={(e) => onChange(list.map((was, i) => (i === index ? e.target.value : was)))} aria-label={`Person in pane ${index + 1}`}>
                {net.info.orgs.map((o) => (
                  <optgroup key={o.code} label={o.name}>
                    {everyone
                      .filter((p) => p.org === o.code)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              <iframe src={frame(id, index)} title={`Fabric Chat as ${id}`} />
            </section>
          );
        })}
      </div>
    </div>
  );
}
