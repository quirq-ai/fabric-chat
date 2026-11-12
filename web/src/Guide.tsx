// The short explanation behind the "How it works" button: what each thing in the app is on Fabric.
import type { CSSProperties } from "react";
import { Modal, useNet } from "./bits";

const MAP: [string, string][] = [
  ["A company, such as Aster Labs", "An organisation. It runs its own peer, its own orderer and its own certificate authority (CA)."],
  ["A person, such as Alice", "A certificate her company's CA signed, and the private key that goes with it. Every message she sends is signed with that key."],
  ["A workspace", "A channel: one ledger, held by the companies on it and by nobody else."],
  ["An open #channel", "Records in the channel's shared state. Every company on the channel stores them, and they appear in the blocks in the clear."],
  ["A private channel or direct message", "Records in a private data collection. Only the companies it names store the text. Everyone else on the channel gets a hash."],
  ["Pressing Send", "A transaction: endorsed by peers, ordered into a block, then checked and applied by every peer on the channel."],
  ["The rules: who may post, edit, join", "Chaincode. The same program runs on every company's peer, and a change counts only if they all reach the same result."],
  ["A message arriving", "A block event. Each company's app watches the blocks its own peer commits. Nothing travels between companies except through the ledger."],
  ["A message's edit history", "The blockchain itself. Each earlier version sits in an earlier block, and each block names the hash of the one before it."],
];

const STEPS: [string, string][] = [
  ["Sign", "The app signs your request with your private key. The chaincode reads who you are from your certificate, never from what you typed."],
  ["Endorse", "Peers run the chaincode and sign the result. In an open channel, more than half of the companies must sign. In a private one, the companies that keep it."],
  ["Order", "The orderers, one per company, agree on an order using Raft and cut a block: after one second, or 50 transactions, whichever comes first."],
  ["Validate and commit", "Every peer on the channel checks the signatures, checks that nothing the transaction read has changed since, and only then updates its own copy."],
];

export function Guide({ onClose }: { onClose: () => void }) {
  const net = useNet();
  const [a, b, c] = net.info.orgs;
  const dots = (on: boolean[]) => (
    <span className="dots big">
      {[a, b, c].map((org, i) => org && <i key={org.code} className={on[i] ? "dot on" : "dot"} style={{ "--org": org.color } as CSSProperties} />)}
    </span>
  );
  return (
    <Modal title="How this chat works on Fabric" onClose={onClose} width={760}>
      <div className="guide">
        <p className="lede">
          This is an ordinary team chat with one difference: there is no central server holding the messages. The three companies each run their own nodes of a Hyperledger Fabric {net.info.fabric} network, and the
          ledger they share is the database.
        </p>

        <h3>What each thing is</h3>
        <table className="map">
          <thead>
            <tr>
              <th>In the app</th>
              <th>On Fabric</th>
            </tr>
          </thead>
          <tbody>
            {MAP.map(([app, fabric]) => (
              <tr key={app}>
                <td>{app}</td>
                <td>{fabric}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>What happens when you press Send</h3>
        <ol className="steps">
          {STEPS.map(([name, text]) => (
            <li key={name}>
              <b>{name}.</b> {text}
            </li>
          ))}
        </ol>

        <h3>How private is a conversation?</h3>
        <p>The dots beside every conversation show which companies' nodes store its text. A hollow dot holds only hashes.</p>
        <ul className="levels">
          <li>
            {dots([true, true, true])}
            <span>
              <b>Open channel.</b> Every company stores the text, and it is in every block.
            </span>
          </li>
          <li>
            {dots([true, true, false])}
            <span>
              <b>Two companies.</b> Their two nodes store the text. The third holds a hash of each message, and can still see who wrote something and when.
            </span>
          </li>
          <li>
            {dots([true, false, false])}
            <span>
              <b>One company.</b> Only its own node stores the text.
            </span>
          </li>
          <li>
            <span className="dots big none">none</span>
            <span>
              <b>A separate workspace.</b> A company that is not on the channel receives nothing: no blocks, no hashes, no sign that it exists.
            </span>
          </li>
        </ul>
        <p className="note">
          Fabric's privacy is between companies, not between people. Whoever runs a company's node can read everything that node stores. To keep something from a colleague in your own company, it would have to be
          encrypted before it is sent.
        </p>
      </div>
    </Modal>
  );
}
