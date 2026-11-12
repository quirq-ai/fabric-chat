// Package main is the chat chaincode: the rules every company's peer runs before it will sign a
// change. The same code runs on each endorsing peer, and a transaction only counts if they all got
// the same result.
//
// Functions that write take a scope and one JSON document of details. Functions that read return
// JSON. Errors start with a code, such as CHAT_NOT_MEMBER, that the app shows a message for.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Chat is the contract Fabric runs.
type Chat struct {
	contractapi.Contract
}

func toJSON(value interface{}) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", fail("CHAT_LEDGER", "the answer could not be written")
	}
	return string(raw), nil
}

/* ---------------------------------------------------------------- people */

// Whoami returns the caller as the chaincode sees them: read from the certificate that signed the
// request, never from an argument.
func (c *Chat) Whoami(ctx contractapi.TransactionContextInterface) (string, error) {
	me, err := whoIs(ctx)
	if err != nil {
		return "", err
	}
	cert, _ := ctx.GetClientIdentity().GetX509Certificate()
	return toJSON(map[string]interface{}{
		"id":      me.ID,
		"handle":  me.Handle,
		"msp":     me.MSP,
		"subject": cert.Subject.String(),
		"issuer":  cert.Issuer.String(),
		"units":   cert.Subject.OrganizationalUnit,
	})
}

// Join puts the caller in this workspace's directory, or updates their entry: {name, title}.
func (c *Chat) Join(ctx contractapi.TransactionContextInterface, details string) (string, error) {
	s, err := open(ctx, scopePublic)
	if err != nil {
		return "", err
	}
	var in struct {
		Name  string `json:"name"`
		Title string `json:"title"`
	}
	if err := s.input(details, &in); err != nil {
		return "", err
	}
	if !handleRe.MatchString(s.me.Handle) {
		return "", fail("CHAT_NO_IDENTITY", "the name on this certificate (%s) cannot be used as a handle", s.me.Handle)
	}
	name := short(in.Name, maxName)
	if name == "" {
		return "", fail("CHAT_BAD_INPUT", "a display name is required")
	}
	profile := &Profile{DocType: "profile", ID: s.me.ID, Handle: s.me.Handle, MSP: s.me.MSP, JoinedAt: s.at}
	if raw, err := s.get(keyProfile + s.me.ID); err != nil {
		return "", err
	} else if raw != nil {
		var old Profile
		if json.Unmarshal(raw, &old) == nil && old.JoinedAt != "" {
			profile.JoinedAt = old.JoinedAt
		}
	}
	profile.Name, profile.Title, profile.TxID = name, short(in.Title, maxName), s.txID
	raw, err := s.put(keyProfile+s.me.ID, profile)
	if err != nil {
		return "", err
	}
	if err := s.announce("profile", "", ""); err != nil {
		return "", err
	}
	return string(raw), nil
}

// Directory lists everyone who has joined this workspace.
func (c *Chat) Directory(ctx contractapi.TransactionContextInterface) (string, error) {
	s, err := open(ctx, scopePublic)
	if err != nil {
		return "", err
	}
	entries, err := s.scan(keyProfile, "")
	if err != nil {
		return "", err
	}
	people := make([]json.RawMessage, 0, len(entries))
	for _, e := range entries {
		people = append(people, e.value)
	}
	return toJSON(people)
}

/* ---------------------------------------------------------------- conversations */

type conversationView struct {
	Conversation
	LastAt  string `json:"lastAt"`
	LastBy  string `json:"lastBy"`
	LastMsg string `json:"lastMsg"`
}

type scopeView struct {
	Scope         string             `json:"scope"`
	Conversations []conversationView `json:"conversations"`
	Error         string             `json:"error,omitempty"`
}

// CreateConversation starts a channel or a direct message in a scope:
// {kind: "channel"|"dm", name, topic, members: [ids], salt}.
//
// Everyone in members must work at a company that keeps the scope. That rule is what makes the
// scope honest: nobody can be in a conversation their own company's peer does not hold.
func (c *Chat) CreateConversation(ctx contractapi.TransactionContextInterface, scopeName, details string) (string, error) {
	s, err := open(ctx, scopeName)
	if err != nil {
		return "", err
	}
	var in struct {
		Kind    string   `json:"kind"`
		Name    string   `json:"name"`
		Topic   string   `json:"topic"`
		Members []string `json:"members"`
		Salt    string   `json:"salt"`
	}
	if err := s.input(details, &in); err != nil {
		return "", err
	}
	if err := s.salted(in.Salt); err != nil {
		return "", err
	}
	if !s.scope.private() {
		if err := s.joined(); err != nil {
			return "", err
		}
	}
	members, err := s.members(in.Members)
	if err != nil {
		return "", err
	}
	conv := &Conversation{
		DocType: "conversation", Scope: s.scope.name, Kind: in.Kind, Topic: short(in.Topic, maxTopic),
		CreatedBy: s.me.ID, CreatedAt: s.at, TxID: s.txID,
	}
	switch in.Kind {
	case "channel":
		conv.Name = slug(in.Name)
		if conv.Name == "" {
			return "", fail("CHAT_BAD_INPUT", "a channel needs a name made of letters or digits")
		}
		if s.scope.private() {
			// A private channel's ID is random. Its key is hashed on the public ledger, and a
			// guessable ID would let an outsider test for it.
			conv.ID = "c-" + s.txID[:16]
			if len(members) == 0 {
				members = []string{s.me.ID}
			}
		} else {
			// A public channel's ID is its name, so the ledger itself keeps names unique.
			conv.ID = conv.Name
		}
	case "dm":
		if len(members) < 2 {
			return "", fail("CHAT_BAD_INPUT", "a direct message needs at least one other person")
		}
		conv.ID = "d-" + s.txID[:16]
	default:
		return "", fail("CHAT_BAD_INPUT", "kind must be channel or dm")
	}
	conv.Members = members
	if conv.Members == nil {
		conv.Members = []string{}
	}
	if s.scope.private() {
		conv.Salt = in.Salt
	}
	if existing, err := s.get(keyConv + conv.ID); err != nil {
		return "", err
	} else if existing != nil {
		return "", fail("CHAT_NAME_TAKEN", "#%s already exists in this workspace", conv.Name)
	}
	raw, err := s.put(keyConv+conv.ID, conv)
	if err != nil {
		return "", err
	}
	if _, err := s.put(keyHead+conv.ID, &Head{ConvID: conv.ID, LastAt: s.at, LastBy: s.me.ID}); err != nil {
		return "", err
	}
	if err := s.announce("conversation", conv.ID, ""); err != nil {
		return "", err
	}
	return string(raw), nil
}

// AddMembers adds people to a members-only conversation: {convId, members: [ids]}.
func (c *Chat) AddMembers(ctx contractapi.TransactionContextInterface, scopeName, details string) (string, error) {
	s, err := open(ctx, scopeName)
	if err != nil {
		return "", err
	}
	var in struct {
		ConvID  string   `json:"convId"`
		Members []string `json:"members"`
	}
	if err := s.input(details, &in); err != nil {
		return "", err
	}
	conv, err := s.conversation(in.ConvID)
	if err != nil {
		return "", err
	}
	if conv.open() {
		return "", fail("CHAT_BAD_INPUT", "#%s is open to everyone already", conv.Name)
	}
	if conv.Kind == "dm" {
		return "", fail("CHAT_BAD_INPUT", "a direct message keeps the people it started with")
	}
	added, err := s.members(append(append([]string{}, conv.Members...), in.Members...))
	if err != nil {
		return "", err
	}
	if len(added) == len(conv.Members) {
		return "", fail("CHAT_NO_CHANGE", "they are all in this conversation already")
	}
	conv.Members, conv.TxID = added, s.txID
	raw, err := s.put(keyConv+conv.ID, conv)
	if err != nil {
		return "", err
	}
	if err := s.announce("conversation", conv.ID, ""); err != nil {
		return "", err
	}
	return string(raw), nil
}

// Overview lists, for each scope asked about, the conversations the caller is in and when each was
// last active. scopes is a JSON list of scope names. A scope this peer cannot read comes back with
// an error instead of conversations; the others are still answered.
func (c *Chat) Overview(ctx contractapi.TransactionContextInterface, scopes string) (string, error) {
	var names []string
	if err := json.Unmarshal([]byte(scopes), &names); err != nil {
		return "", fail("CHAT_BAD_INPUT", "scopes must be a JSON list of scope names")
	}
	out := make([]scopeView, 0, len(names))
	for _, name := range names {
		view := scopeView{Scope: name, Conversations: []conversationView{}}
		if err := overviewOf(ctx, name, &view); err != nil {
			view.Error = err.Error()
		}
		out = append(out, view)
	}
	return toJSON(out)
}

func overviewOf(ctx contractapi.TransactionContextInterface, name string, view *scopeView) error {
	s, err := open(ctx, name)
	if err != nil {
		return err
	}
	convs, err := s.scan(keyConv, "")
	if err != nil {
		return err
	}
	headEntries, err := s.scan(keyHead, "")
	if err != nil {
		return err
	}
	heads := map[string]Head{}
	for _, e := range headEntries {
		var h Head
		if json.Unmarshal(e.value, &h) == nil {
			heads[h.ConvID] = h
		}
	}
	for _, e := range convs {
		var conv Conversation
		if json.Unmarshal(e.value, &conv) != nil || !conv.has(s.me.ID) {
			continue
		}
		conv.Salt = ""
		h := heads[conv.ID]
		view.Conversations = append(view.Conversations, conversationView{Conversation: conv, LastAt: h.LastAt, LastBy: h.LastBy, LastMsg: h.LastMsg})
	}
	return nil
}

/* ---------------------------------------------------------------- messages */

// Post adds a message: {convId, text, salt}.
func (c *Chat) Post(ctx contractapi.TransactionContextInterface, scopeName, details string) (string, error) {
	s, err := open(ctx, scopeName)
	if err != nil {
		return "", err
	}
	var in struct {
		ConvID string `json:"convId"`
		Text   string `json:"text"`
		Salt   string `json:"salt"`
	}
	if err := s.input(details, &in); err != nil {
		return "", err
	}
	if err := s.salted(in.Salt); err != nil {
		return "", err
	}
	conv, err := s.conversation(in.ConvID)
	if err != nil {
		return "", err
	}
	if !s.scope.private() {
		if err := s.joined(); err != nil {
			return "", err
		}
	}
	text := body(in.Text)
	if text == "" {
		return "", fail("CHAT_BAD_INPUT", "a message needs some text")
	}
	// The ID starts with the time, so messages sort in the order they were sent, and ends with part
	// of the transaction ID, so two messages sent in the same millisecond still differ.
	msg := &Message{
		DocType: "message", ID: fmt.Sprintf("%013d-%s", s.ms, s.txID[:8]), ConvID: conv.ID, Author: s.me.ID,
		Text: text, SentAt: s.at, TxID: s.txID, FirstTx: s.txID,
	}
	if s.scope.private() {
		msg.Salt = in.Salt
	}
	raw, err := s.put(keyMessage+conv.ID+"~"+msg.ID, msg)
	if err != nil {
		return "", err
	}
	if _, err := s.put(keyHead+conv.ID, &Head{ConvID: conv.ID, LastAt: s.at, LastBy: s.me.ID, LastMsg: msg.ID}); err != nil {
		return "", err
	}
	if err := s.announce("message", conv.ID, msg.ID); err != nil {
		return "", err
	}
	return string(raw), nil
}

// Messages returns a conversation's messages in the order they were sent, with their reactions.
// With after set to a message ID, it returns only the messages sent after that one.
func (c *Chat) Messages(ctx contractapi.TransactionContextInterface, scopeName, convID, after string) (string, error) {
	s, err := open(ctx, scopeName)
	if err != nil {
		return "", err
	}
	conv, err := s.conversation(convID)
	if err != nil {
		return "", err
	}
	if after != "" && !msgRe.MatchString(after) {
		return "", fail("CHAT_BAD_INPUT", "that is not a message id")
	}
	entries, err := s.scan(keyMessage+conv.ID+"~", after)
	if err != nil {
		return "", err
	}
	messages := make([]*Message, 0, len(entries))
	for _, e := range entries {
		var msg Message
		if json.Unmarshal(e.value, &msg) != nil {
			continue
		}
		msg.Salt = ""
		messages = append(messages, &msg)
	}
	// message ID -> emoji -> the people who reacted with it
	reactions := map[string]map[string][]string{}
	reacts, err := s.scan(keyReaction+conv.ID+"~", "")
	if err != nil {
		return "", err
	}
	for _, e := range reacts {
		parts := strings.Split(e.key, "~") // react, conversation, message, emoji, person
		if len(parts) != 5 {
			continue
		}
		if reactions[parts[2]] == nil {
			reactions[parts[2]] = map[string][]string{}
		}
		reactions[parts[2]][parts[3]] = append(reactions[parts[2]][parts[3]], parts[4])
	}
	conv.Salt = ""
	return toJSON(map[string]interface{}{"conversation": conv, "messages": messages, "reactions": reactions})
}

// Edit changes the text of the caller's own message: {convId, msgId, text, salt}.
func (c *Chat) Edit(ctx contractapi.TransactionContextInterface, scopeName, details string) (string, error) {
	s, err := open(ctx, scopeName)
	if err != nil {
		return "", err
	}
	var in struct {
		ConvID string `json:"convId"`
		MsgID  string `json:"msgId"`
		Text   string `json:"text"`
		Salt   string `json:"salt"`
	}
	if err := s.input(details, &in); err != nil {
		return "", err
	}
	if err := s.salted(in.Salt); err != nil {
		return "", err
	}
	conv, err := s.conversation(in.ConvID)
	if err != nil {
		return "", err
	}
	msg, key, err := s.message(conv.ID, in.MsgID)
	if err != nil {
		return "", err
	}
	if msg.Author != s.me.ID {
		return "", fail("CHAT_NOT_AUTHOR", "only %s can change this message", msg.Author)
	}
	if msg.Deleted {
		return "", fail("CHAT_GONE", "this message was deleted")
	}
	text := body(in.Text)
	if text == "" {
		return "", fail("CHAT_BAD_INPUT", "a message needs some text")
	}
	if text == msg.Text {
		return "", fail("CHAT_NO_CHANGE", "the text is the same")
	}
	msg.Text, msg.EditedAt, msg.TxID = text, s.at, s.txID
	if s.scope.private() {
		msg.Salt = in.Salt
	}
	raw, err := s.put(key, msg)
	if err != nil {
		return "", err
	}
	if err := s.announce("edit", conv.ID, msg.ID); err != nil {
		return "", err
	}
	return string(raw), nil
}

// Delete removes the caller's own message: {convId, msgId, reactions: [{emoji, by}]}.
//
// The two kinds of scope behave differently, and the difference is the point:
//   - public: the text is blanked, but every earlier version stays in the blocks for good.
//   - private: the record is purged from every member peer, history included. Only its hashes
//     remain on the ledger, as proof that something was there.
func (c *Chat) Delete(ctx contractapi.TransactionContextInterface, scopeName, details string) (string, error) {
	s, err := open(ctx, scopeName)
	if err != nil {
		return "", err
	}
	var in struct {
		ConvID    string `json:"convId"`
		MsgID     string `json:"msgId"`
		Reactions []struct {
			Emoji string `json:"emoji"`
			By    string `json:"by"`
		} `json:"reactions"`
	}
	if err := s.input(details, &in); err != nil {
		return "", err
	}
	conv, err := s.conversation(in.ConvID)
	if err != nil {
		return "", err
	}
	msg, key, err := s.message(conv.ID, in.MsgID)
	if err != nil {
		return "", err
	}
	if msg.Author != s.me.ID {
		return "", fail("CHAT_NOT_AUTHOR", "only %s can delete this message", msg.Author)
	}
	if s.scope.private() {
		if err := s.stub.PurgePrivateData(s.scope.name, key); err != nil {
			return "", fail("CHAT_LEDGER", "the message could not be purged: %s", brief(err))
		}
		// A transaction may not search a private collection and write to it as well, so the app
		// names the reactions to clear instead of this code looking them up.
		for _, r := range in.Reactions {
			if !emojiRe.MatchString(r.Emoji) || !userRe.MatchString(r.By) {
				return "", fail("CHAT_BAD_INPUT", "that is not a reaction")
			}
			if err := s.stub.PurgePrivateData(s.scope.name, keyReaction+conv.ID+"~"+msg.ID+"~"+r.Emoji+"~"+r.By); err != nil {
				return "", fail("CHAT_LEDGER", "a reaction could not be purged: %s", brief(err))
			}
		}
	} else {
		if msg.Deleted {
			return "", fail("CHAT_NO_CHANGE", "this message is deleted already")
		}
		msg.Text, msg.Deleted, msg.EditedAt, msg.TxID = "", true, s.at, s.txID
		if _, err := s.put(key, msg); err != nil {
			return "", err
		}
	}
	if err := s.announce("delete", conv.ID, msg.ID); err != nil {
		return "", err
	}
	return toJSON(map[string]interface{}{"id": msg.ID, "convId": conv.ID, "purged": s.scope.private()})
}

// React adds or removes the caller's reaction to a message: {convId, msgId, emoji, on}.
// Each reaction is its own key, so any number of people can react at once without a conflict.
func (c *Chat) React(ctx contractapi.TransactionContextInterface, scopeName, details string) (string, error) {
	s, err := open(ctx, scopeName)
	if err != nil {
		return "", err
	}
	var in struct {
		ConvID string `json:"convId"`
		MsgID  string `json:"msgId"`
		Emoji  string `json:"emoji"`
		On     bool   `json:"on"`
	}
	if err := s.input(details, &in); err != nil {
		return "", err
	}
	if !emojiRe.MatchString(in.Emoji) {
		return "", fail("CHAT_BAD_INPUT", "that is not a reaction")
	}
	conv, err := s.conversation(in.ConvID)
	if err != nil {
		return "", err
	}
	msg, _, err := s.message(conv.ID, in.MsgID)
	if err != nil {
		return "", err
	}
	if msg.Deleted {
		return "", fail("CHAT_GONE", "this message was deleted")
	}
	key := keyReaction + conv.ID + "~" + msg.ID + "~" + in.Emoji + "~" + s.me.ID
	if in.On {
		if _, err := s.put(key, map[string]string{"at": s.at}); err != nil {
			return "", err
		}
	} else if err := s.del(key); err != nil {
		return "", err
	}
	if err := s.announce("reaction", conv.ID, msg.ID); err != nil {
		return "", err
	}
	return toJSON(map[string]interface{}{"convId": conv.ID, "msgId": msg.ID, "emoji": in.Emoji, "on": in.On})
}

/* ---------------------------------------------------------------- looking at the ledger itself */

type version struct {
	TxID    string `json:"txId"`
	At      string `json:"at"`
	Text    string `json:"text"`
	Deleted bool   `json:"deleted"`
}

// History returns every version a public message has had, oldest first. The ledger keeps them all;
// nothing a later transaction does can remove an earlier one. Private scopes keep no readable
// history: there, only the hash of each version is on the ledger.
func (c *Chat) History(ctx contractapi.TransactionContextInterface, convID, msgID string) (string, error) {
	s, err := open(ctx, scopePublic)
	if err != nil {
		return "", err
	}
	conv, err := s.conversation(convID)
	if err != nil {
		return "", err
	}
	if !msgRe.MatchString(msgID) {
		return "", fail("CHAT_BAD_INPUT", "that is not a message id")
	}
	it, err := s.stub.GetHistoryForKey(keyMessage + conv.ID + "~" + msgID)
	if err != nil {
		return "", fail("CHAT_LEDGER", "the history could not be read: %s", brief(err))
	}
	defer it.Close()
	versions := []version{}
	for it.HasNext() {
		mod, err := it.Next()
		if err != nil {
			return "", fail("CHAT_LEDGER", "the history could not be read")
		}
		v := version{TxID: mod.GetTxId(), Deleted: mod.GetIsDelete()}
		if ts := mod.GetTimestamp(); ts != nil {
			v.At = time.Unix(ts.GetSeconds(), int64(ts.GetNanos())).UTC().Format(timeLayout)
		}
		var msg Message
		if json.Unmarshal(mod.GetValue(), &msg) == nil {
			v.Text = msg.Text
			v.Deleted = v.Deleted || msg.Deleted
		}
		versions = append(versions, v)
	}
	sort.SliceStable(versions, func(i, j int) bool { return versions[i].At < versions[j].At })
	return toJSON(versions)
}

// Inspect reports what the peer that runs it holds for one key: whether it has the record itself,
// and the hash the ledger carries for it. It returns hashes only, never the record.
//
// Asked of a company outside a private scope, held is false and ledgerHash is still filled in: that
// company cannot read the message, yet it holds the proof of what was said.
func (c *Chat) Inspect(ctx contractapi.TransactionContextInterface, scopeName, key string) (string, error) {
	sc, err := parseScope(scopeName)
	if err != nil {
		return "", err
	}
	if key == "" || len(key) > 300 {
		return "", fail("CHAT_BAD_INPUT", "a key is required")
	}
	stub := ctx.GetStub()
	out := map[string]interface{}{"scope": sc.name, "key": key, "held": false, "heldHash": "", "ledgerHash": "", "bytes": 0, "note": ""}
	digest := func(raw []byte) string {
		sum := sha256.Sum256(raw)
		return hex.EncodeToString(sum[:])
	}
	if !sc.private() {
		raw, err := stub.GetState(key)
		if err != nil {
			return "", fail("CHAT_LEDGER", "could not read %s", key)
		}
		if raw != nil {
			out["held"], out["heldHash"], out["ledgerHash"], out["bytes"] = true, digest(raw), digest(raw), len(raw)
		}
		return toJSON(out)
	}
	if raw, err := stub.GetPrivateData(sc.name, key); err != nil {
		out["note"] = brief(err)
	} else if raw != nil {
		out["held"], out["heldHash"], out["bytes"] = true, digest(raw), len(raw)
	}
	if hash, err := stub.GetPrivateDataHash(sc.name, key); err != nil {
		out["note"] = brief(err)
	} else if hash != nil {
		out["ledgerHash"] = hex.EncodeToString(hash)
	}
	return toJSON(out)
}
