// The short explanation behind the "How it works" button: what each thing in the app is on Fabric.
// The sandbox explains three companies sharing a ledger. A company's own server explains one.
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

/** The same table for one company on its own server. */
const OWN_MAP = (company: string): [string, string][] => [
  [company, "An organisation on Fabric. It runs its own peer, its own orderer and its own certificate authority (CA), all on this server."],
  ["A person", "A certificate the company's CA signed, and the private key that goes with it. Every message they send is signed with that key."],
  ["Signing in", "A password, checked by this server. It unlocks the use of your key. It is not part of the ledger."],
  [`${company}'s own workspace`, `A channel: one ledger. Only ${company} is on it, so no other company holds any part of it.`],
  ["A workspace shared with other companies", "Another channel: a ledger held by exactly the companies on it. Each keeps a full copy, and more than half of them must sign a message before it counts."],
  ["An open #channel", "Records in the channel's shared state. They appear in the blocks in the clear, and everyone at the company can read them."],
  ["A members-only channel or direct message", "Records in the company's private data collection. The blocks carry only a hash of each one, and the chaincode shows the text to members only."],
  ["Pressing Send", "A transaction: endorsed by the peer, ordered into a block, then checked and applied to the ledger."],
  ["The rules: who may post, edit, join", "Chaincode: a program the peer runs before it will sign any change."],
  ["A message's edit history", "The blockchain itself. Each earlier version sits in an earlier block, and each block names the hash of the one before it."],
];

const OWN_STEPS: [string, string][] = [
  ["Sign", "The server signs your request with your private key. The chaincode reads who you are from your certificate, never from what you typed."],
  ["Endorse", "The company's peer runs the chaincode and signs the result. In a workspace shared with other companies, more than half of the companies' peers must sign."],
  ["Order", "The orderer cuts a block: after one second, or 50 transactions, whichever comes first. In a shared workspace each company has an orderer, and they agree on the order between them."],
  ["Validate and commit", "The peer checks the signatures, checks that nothing the transaction read has changed since, and only then updates the ledger."],
];

export function Guide({ onClose }: { onClose: () => void }) {
  const net = useNet();
  const own = net.info.mode === "company" ? net.info.company : undefined;
  const [a, b, c] = net.info.orgs;
  const dots = (on: boolean[]) => (
    <span className="dots big">
      {[a, b, c].map((org, i) => org && <i key={org.code} className={on[i] ? "dot on" : "dot"} style={{ "--org": org.color } as CSSProperties} />)}
    </span>
  );
  const map = own ? OWN_MAP(own.name) : MAP;
  const steps = own ? OWN_STEPS : STEPS;
  return (
    <Modal title="How this chat works on Fabric" onClose={onClose} width={760}>
      <div className="guide">
        {own ? (
          <p className="lede">
            This is an ordinary team chat with one difference: the messages are not rows in a database that someone could quietly change. {own.name} runs its own node of Hyperledger Fabric {net.info.fabric}, and that node's
            ledger is the database.
          </p>
        ) : (
          <p className="lede">
            This is an ordinary team chat with one difference: there is no central server holding the messages. The three companies each run their own nodes of a Hyperledger Fabric {net.info.fabric} network, and the
            ledger they share is the database.
          </p>
        )}

        <h3>What each thing is</h3>
        <table className="map">
          <thead>
            <tr>
              <th>In the app</th>
              <th>On Fabric</th>
            </tr>
          </thead>
          <tbody>
            {map.map(([app, fabric]) => (
              <tr key={app}>
                <td>{app}</td>
                <td>{fabric}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>What happens when you press Send</h3>
        <ol className="steps">
          {steps.map(([name, text]) => (
            <li key={name}>
              <b>{name}.</b> {text}
            </li>
          ))}
        </ol>

        {own ? (
          <>
            <h3>Who can read a conversation?</h3>
            <ul className="levels">
              <li>
                {dots([true])}
                <span>
                  <b>Open channel.</b> Everyone at {own.name}. The text is in the blocks, so an edited or deleted message leaves its earlier versions on the ledger.
                </span>
              </li>
              <li>
                {dots([true])}
                <span>
                  <b>Members only.</b> The people in it, and nobody else at the company. The blocks carry only a hash of each message, so deleting one really removes it.
                </span>
              </li>
              <li>
                <span className="dots big none">none</span>
                <span>
                  <b>Other companies.</b> None of them holds any part of {own.name}'s own workspace. In a workspace shared with them, each holds everything said in an open channel or in a conversation with its people in it, and only
                  hashes of what {own.name}'s people say among themselves.
                </span>
              </li>
            </ul>
            <p className="note">
              Whoever runs {own.name}'s node can read everything it stores, and its certificate authority could sign a certificate in anyone's name. As with company email, the company's administrators are trusted.
            </p>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </Modal>
  );
}
