package main

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// scope is a parsed scope name: where the data lives and which companies' peers store it.
type scope struct {
	name string
	orgs []string // MSP IDs; nil for the public scope
}

func parseScope(name string) (*scope, error) {
	if name == scopePublic {
		return &scope{name: name}, nil
	}
	if strings.HasPrefix(name, implicitPrefix) {
		msp := strings.TrimPrefix(name, implicitPrefix)
		if !mspRe.MatchString(msp) {
			return nil, fail("CHAT_BAD_SCOPE", "%q is not a scope", name)
		}
		return &scope{name: name, orgs: []string{msp}}, nil
	}
	// A shared collection is named after its member companies: AsterMSP-BirchMSP.
	parts := strings.Split(name, "-")
	if len(parts) < 2 {
		return nil, fail("CHAT_BAD_SCOPE", "%q is not a scope", name)
	}
	for _, part := range parts {
		if !mspRe.MatchString(part) {
			return nil, fail("CHAT_BAD_SCOPE", "%q is not a scope", name)
		}
	}
	return &scope{name: name, orgs: parts}, nil
}

func (s *scope) private() bool { return s.name != scopePublic }

// holds says whether a company's peers store this scope.
func (s *scope) holds(msp string) bool { return !s.private() || contains(s.orgs, msp) }

// caller is who signed the transaction, read from their certificate. Nothing the caller types can
// change it: the peer checks the signature against the certificate before the chaincode runs.
type caller struct {
	ID     string // alice@AsterMSP
	Handle string
	MSP    string
}

func whoIs(ctx contractapi.TransactionContextInterface) (*caller, error) {
	id := ctx.GetClientIdentity()
	msp, err := id.GetMSPID()
	if err != nil || msp == "" {
		return nil, fail("CHAT_NO_IDENTITY", "the caller's organisation could not be read")
	}
	cert, err := id.GetX509Certificate()
	if err != nil || cert == nil {
		return nil, fail("CHAT_NO_IDENTITY", "the caller's certificate could not be read")
	}
	handle := strings.ToLower(strings.TrimSpace(cert.Subject.CommonName))
	return &caller{ID: handle + "@" + msp, Handle: handle, MSP: msp}, nil
}

// session is one transaction: the ledger, the scope it works in, who is calling and when.
type session struct {
	stub  shim.ChaincodeStubInterface
	scope *scope
	me    *caller
	at    string // the transaction's own time, the same on every peer that runs it
	ms    int64
	txID  string
}

// open starts a transaction in a scope. It refuses a caller whose company is not part of the scope.
func open(ctx contractapi.TransactionContextInterface, scopeName string) (*session, error) {
	sc, err := parseScope(scopeName)
	if err != nil {
		return nil, err
	}
	me, err := whoIs(ctx)
	if err != nil {
		return nil, err
	}
	if !sc.holds(me.MSP) {
		return nil, fail("CHAT_WRONG_SCOPE", "%s is not one of the companies that keep %s", me.MSP, sc.name)
	}
	stub := ctx.GetStub()
	// The system clock is never used: each endorsing peer would read a different time, and their
	// results would not match.
	ts, err := stub.GetTxTimestamp()
	if err != nil || ts == nil {
		return nil, fail("CHAT_NO_TIME", "the transaction time could not be read")
	}
	t := time.Unix(ts.GetSeconds(), int64(ts.GetNanos())).UTC()
	return &session{stub: stub, scope: sc, me: me, at: t.Format(timeLayout), ms: t.UnixMilli(), txID: stub.GetTxID()}, nil
}

// input reads the one JSON argument of a transaction that writes.
//
// In the public scope it is an ordinary argument. Ordinary arguments are recorded in the block for
// every company to read, so in a private scope the details travel in the transient field instead:
// the peers that endorse see it, and it is never written to the ledger.
func (s *session) input(arg string, into interface{}) error {
	raw := []byte(arg)
	if s.scope.private() {
		if arg != "" {
			return fail("CHAT_BAD_INPUT", "in a private scope the details go in the transient field, not in an argument")
		}
		transient, err := s.stub.GetTransient()
		if err != nil {
			return fail("CHAT_BAD_INPUT", "the transient field could not be read")
		}
		raw = transient["payload"]
	}
	if len(raw) == 0 {
		return fail("CHAT_BAD_INPUT", "this function needs its details as JSON")
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fail("CHAT_BAD_INPUT", "the details are not valid JSON")
	}
	return nil
}

func (s *session) get(key string) ([]byte, error) {
	if s.scope.private() {
		raw, err := s.stub.GetPrivateData(s.scope.name, key)
		if err != nil {
			return nil, fail("CHAT_NOT_HELD", "this peer cannot read %s: %s", s.scope.name, brief(err))
		}
		return raw, nil
	}
	raw, err := s.stub.GetState(key)
	if err != nil {
		return nil, fail("CHAT_LEDGER", "could not read %s", key)
	}
	return raw, nil
}

// canonical writes a record as JSON with its keys in alphabetical order at every level.
//
// CouchDB keeps a record as a document and hands it back with the keys in that order, whatever
// order it was written in. Writing them that way to begin with means a peer reads back exactly the
// bytes that were written, so the hash of what a peer holds equals the hash on the ledger.
func canonical(record interface{}) ([]byte, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	var plain interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&plain); err != nil {
		return nil, err
	}
	return json.Marshal(plain)
}

func (s *session) put(key string, record interface{}) ([]byte, error) {
	raw, err := canonical(record)
	if err != nil {
		return nil, fail("CHAT_LEDGER", "could not write %s", key)
	}
	if s.scope.private() {
		err = s.stub.PutPrivateData(s.scope.name, key, raw)
	} else {
		err = s.stub.PutState(key, raw)
	}
	if err != nil {
		return nil, fail("CHAT_LEDGER", "could not write %s: %s", key, brief(err))
	}
	return raw, nil
}

func (s *session) del(key string) error {
	var err error
	if s.scope.private() {
		err = s.stub.DelPrivateData(s.scope.name, key)
	} else {
		err = s.stub.DelState(key)
	}
	if err != nil {
		return fail("CHAT_LEDGER", "could not remove %s", key)
	}
	return nil
}

type entry struct {
	key   string
	value []byte
}

// scan returns every record whose key starts with prefix, in key order. With after set, it returns
// only the records that come after prefix+after.
func (s *session) scan(prefix, after string) ([]entry, error) {
	start, end := prefix+after, prefix+"~" // "~" sorts after every character a key part may hold
	var it shim.StateQueryIteratorInterface
	var err error
	if s.scope.private() {
		it, err = s.stub.GetPrivateDataByRange(s.scope.name, start, end)
	} else {
		it, err = s.stub.GetStateByRange(start, end)
	}
	if err != nil {
		return nil, fail("CHAT_NOT_HELD", "this peer cannot read %s: %s", s.scope.name, brief(err))
	}
	defer it.Close()
	var out []entry
	for it.HasNext() {
		kv, err := it.Next()
		if err != nil {
			return nil, fail("CHAT_LEDGER", "could not read %s", prefix)
		}
		if after != "" && kv.GetKey() == start {
			continue
		}
		out = append(out, entry{key: kv.GetKey(), value: kv.GetValue()})
	}
	return out, nil
}

// announce attaches the transaction's one event. Events are part of the block, which every company
// on the channel receives, so a private scope's event says only that something happened there.
func (s *session) announce(kind, convID, msgID string) error {
	event := map[string]string{"type": kind, "scope": s.scope.name}
	if !s.scope.private() {
		event["by"] = s.me.ID
		if convID != "" {
			event["convId"] = convID
		}
		if msgID != "" {
			event["msgId"] = msgID
		}
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return fail("CHAT_LEDGER", "the change could not be announced")
	}
	if err := s.stub.SetEvent("chat", raw); err != nil {
		return fail("CHAT_LEDGER", "the change could not be announced")
	}
	return nil
}

// joined refuses a caller who is not in the workspace's directory.
func (s *session) joined() error {
	raw, err := s.stub.GetState(keyProfile + s.me.ID)
	if err != nil {
		return fail("CHAT_LEDGER", "could not read the directory")
	}
	if raw == nil {
		return fail("CHAT_NOT_JOINED", "%s has not joined this workspace", s.me.ID)
	}
	return nil
}

// conversation loads a conversation of this scope and refuses a caller who is not in it.
func (s *session) conversation(id string) (*Conversation, error) {
	if !convRe.MatchString(id) {
		return nil, fail("CHAT_BAD_INPUT", "that is not a conversation id")
	}
	raw, err := s.get(keyConv + id)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fail("CHAT_NOT_FOUND", "there is no such conversation here")
	}
	var conv Conversation
	if err := json.Unmarshal(raw, &conv); err != nil {
		return nil, fail("CHAT_LEDGER", "the conversation is not readable")
	}
	if !conv.has(s.me.ID) {
		return nil, fail("CHAT_NOT_MEMBER", "%s is not in this conversation", s.me.ID)
	}
	return &conv, nil
}

func (s *session) message(convID, msgID string) (*Message, string, error) {
	if !msgRe.MatchString(msgID) {
		return nil, "", fail("CHAT_BAD_INPUT", "that is not a message id")
	}
	key := keyMessage + convID + "~" + msgID
	raw, err := s.get(key)
	if err != nil {
		return nil, "", err
	}
	if raw == nil {
		return nil, "", fail("CHAT_NOT_FOUND", "there is no such message")
	}
	var msg Message
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil, "", fail("CHAT_LEDGER", "the message is not readable")
	}
	return &msg, key, nil
}

// members checks a member list and returns it sorted, without repeats and with the caller in it.
// An empty list stays empty: that is an open channel.
func (s *session) members(list []string) ([]string, error) {
	if len(list) == 0 {
		return nil, nil
	}
	seen := map[string]bool{s.me.ID: true}
	for _, id := range list {
		id = strings.TrimSpace(id)
		parts := userRe.FindStringSubmatch(id)
		if parts == nil {
			return nil, fail("CHAT_BAD_INPUT", "%q is not a person's id", id)
		}
		if !s.scope.holds(parts[2]) {
			return nil, fail("CHAT_WRONG_SCOPE", "%s works at a company that does not keep %s", id, s.scope.name)
		}
		if !s.scope.private() && !seen[id] {
			// Checked only in the public scope. In a private one this read would be recorded in the
			// public part of the transaction, and show everyone who was being added.
			raw, err := s.stub.GetState(keyProfile + id)
			if err != nil {
				return nil, fail("CHAT_LEDGER", "could not read the directory")
			}
			if raw == nil {
				return nil, fail("CHAT_UNKNOWN_USER", "%s has not joined this workspace", id)
			}
		}
		seen[id] = true
	}
	if len(seen) > maxMembers {
		return nil, fail("CHAT_BAD_INPUT", "a conversation holds at most %d people", maxMembers)
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}

// salted refuses a private record that carries no salt. See Message.Salt.
func (s *session) salted(salt string) error {
	if s.scope.private() && len(salt) < 16 {
		return fail("CHAT_BAD_INPUT", "a private record needs a random salt of at least 16 characters")
	}
	return nil
}

// brief is the last part of a peer's error, which is the part worth showing.
func brief(err error) string {
	text := err.Error()
	if i := strings.LastIndex(text, ": "); i >= 0 && i+2 < len(text) {
		text = text[i+2:]
	}
	return cut(text, 160)
}
