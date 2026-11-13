package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

const (
	alice  = "alice@AsterMSP"
	arjun  = "arjun@AsterMSP"
	bob    = "bob@BirchMSP"
	carol  = "carol@CedarMSP"
	pair   = "AsterMSP-BirchMSP"      // kept by Aster's and Birch's peers only
	asters = "_implicit_org_AsterMSP" // kept by Aster's peers only
	salt   = "0123456789abcdef0123456789abcdef"
)

var chat = &Chat{}

type ctxT = contractapi.TransactionContextInterface

// write is the shape every writing transaction has: a scope and one JSON document of details.
type write func(ctx ctxT, scope, details string) (string, error)

// office is a channel where the four people have joined the directory.
func office(t *testing.T) *world {
	w := newWorld(t)
	for _, who := range []string{alice, arjun, bob, carol} {
		w.must(w.as(who, "", func(ctx ctxT) (string, error) { return chat.Join(ctx, `{"name":"`+who[:strings.Index(who, "@")]+`"}`) }))
	}
	return w
}

func (w *world) must(out string, err error) string {
	w.t.Helper()
	if err != nil {
		w.t.Fatalf("unexpected error: %v", err)
	}
	return out
}

// refuse checks that a transaction was turned down with the given code.
func (w *world) refuse(code string) func(string, error) {
	return func(_ string, err error) {
		w.t.Helper()
		if err == nil {
			w.t.Fatalf("expected %s, but the transaction went through", code)
		}
		if !strings.HasPrefix(err.Error(), code+":") {
			w.t.Fatalf("expected %s, got: %v", code, err)
		}
	}
}

// submit sends a writing transaction the way the app does: details as an argument in the public
// scope, and in the transient field in a private one.
func (w *world) submit(who, scope string, fn write, details string) (string, error) {
	if scope == scopePublic {
		return w.as(who, "", func(ctx ctxT) (string, error) { return fn(ctx, scope, details) })
	}
	return w.as(who, details, func(ctx ctxT) (string, error) { return fn(ctx, scope, "") })
}

func (w *world) channel(who, scope, name string, members ...string) Conversation {
	w.t.Helper()
	list, _ := json.Marshal(members)
	out := w.must(w.submit(who, scope, chat.CreateConversation, fmt.Sprintf(`{"kind":"channel","name":%q,"members":%s,"salt":%q}`, name, list, salt)))
	return decode[Conversation](w.t, out)
}

func (w *world) post(who, scope, convID, text string) Message {
	w.t.Helper()
	out := w.must(w.submit(who, scope, chat.Post, fmt.Sprintf(`{"convId":%q,"text":%q,"salt":%q}`, convID, text, salt)))
	return decode[Message](w.t, out)
}

type thread struct {
	Conversation Conversation                   `json:"conversation"`
	Messages     []Message                      `json:"messages"`
	Reactions    map[string]map[string][]string `json:"reactions"`
}

func (w *world) read(who, scope, convID, after string) (string, error) {
	return w.as(who, "", func(ctx ctxT) (string, error) { return chat.Messages(ctx, scope, convID, after) })
}

func decode[T any](t *testing.T, raw string) T {
	t.Helper()
	var value T
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, raw)
	}
	return value
}

func TestJoinPutsPeopleInTheDirectory(t *testing.T) {
	w := office(t)
	people := decode[[]Profile](t, w.must(w.as(carol, "", func(ctx ctxT) (string, error) { return chat.Directory(ctx) })))
	if len(people) != 4 || people[0].ID != alice || people[0].MSP != "AsterMSP" {
		t.Fatalf("directory is wrong: %+v", people)
	}
	joined := people[0].JoinedAt
	again := decode[Profile](t, w.must(w.as(alice, "", func(ctx ctxT) (string, error) { return chat.Join(ctx, `{"name":"Alice Ahn","title":"Product"}`) })))
	if again.Name != "Alice Ahn" || again.JoinedAt != joined {
		t.Fatalf("joining again should change the name and keep the first date: %+v", again)
	}
}

func TestPublicChannelNamesAreUnique(t *testing.T) {
	w := office(t)
	general := w.channel(alice, scopePublic, "General")
	if general.ID != "general" || general.Name != "general" || len(general.Members) != 0 {
		t.Fatalf("unexpected channel: %+v", general)
	}
	w.refuse("CHAT_NAME_TAKEN")(w.submit(bob, scopePublic, chat.CreateConversation, `{"kind":"channel","name":"general"}`))
	w.refuse("CHAT_BAD_INPUT")(w.submit(bob, scopePublic, chat.CreateConversation, `{"kind":"channel","name":"!!!"}`))
}

func TestMessagesComeBackInOrder(t *testing.T) {
	w := office(t)
	w.channel(alice, scopePublic, "general")
	first := w.post(alice, scopePublic, "general", "hello")
	w.post(bob, scopePublic, "general", "hi Alice")
	w.post(carol, scopePublic, "general", "morning")

	all := decode[thread](t, w.must(w.read(carol, scopePublic, "general", "")))
	if len(all.Messages) != 3 || all.Messages[0].Text != "hello" || all.Messages[2].Author != carol {
		t.Fatalf("unexpected messages: %+v", all.Messages)
	}
	later := decode[thread](t, w.must(w.read(carol, scopePublic, "general", first.ID)))
	if len(later.Messages) != 2 || later.Messages[0].Text != "hi Alice" {
		t.Fatalf("after the first message there should be two: %+v", later.Messages)
	}
	w.refuse("CHAT_BAD_INPUT")(w.submit(alice, scopePublic, chat.Post, `{"convId":"general","text":"   "}`))
	w.refuse("CHAT_NOT_FOUND")(w.submit(alice, scopePublic, chat.Post, `{"convId":"nowhere","text":"x"}`))
}

func TestSomeoneWhoHasNotJoinedCannotPost(t *testing.T) {
	w := office(t)
	w.channel(alice, scopePublic, "general")
	w.refuse("CHAT_NOT_JOINED")(w.submit("mallory@CedarMSP", scopePublic, chat.Post, `{"convId":"general","text":"hi"}`))
	w.refuse("CHAT_UNKNOWN_USER")(w.submit(alice, scopePublic, chat.CreateConversation, `{"kind":"channel","name":"x","members":["mallory@CedarMSP"]}`))
}

func TestMembersOnlyChannelInThePublicScope(t *testing.T) {
	w := office(t)
	launch := w.channel(alice, scopePublic, "launch", bob)
	if strings.Join(launch.Members, ",") != alice+","+bob {
		t.Fatalf("the creator should be added to the members: %+v", launch.Members)
	}
	w.post(bob, scopePublic, "launch", "ready")
	w.refuse("CHAT_NOT_MEMBER")(w.read(carol, scopePublic, "launch", ""))
	w.refuse("CHAT_NOT_MEMBER")(w.submit(carol, scopePublic, chat.Post, `{"convId":"launch","text":"me too"}`))

	// Adding Carol lets her in. Any company's people may join, because every company holds the public scope.
	w.must(w.submit(bob, scopePublic, chat.AddMembers, `{"convId":"launch","members":["`+carol+`"]}`))
	w.must(w.read(carol, scopePublic, "launch", ""))
	w.refuse("CHAT_NO_CHANGE")(w.submit(bob, scopePublic, chat.AddMembers, `{"convId":"launch","members":["`+carol+`"]}`))
}

func TestPrivateScopeKeepsDetailsOffTheSharedLedger(t *testing.T) {
	w := office(t)
	deal := w.channel(alice, pair, "pricing", bob)
	if !strings.HasPrefix(deal.ID, "c-") || deal.Scope != pair {
		t.Fatalf("a private channel gets a random id: %+v", deal)
	}
	msg := w.post(alice, pair, deal.ID, "our floor is 40")

	// The transaction read and wrote nothing in the shared state, and its event names no conversation.
	if len(w.last.publicReads) != 0 || len(w.last.publicWrites) != 0 {
		t.Fatalf("a private post touched the shared state: reads %v", w.last.publicReads)
	}
	if strings.Contains(string(w.last.eventPayload), deal.ID) || strings.Contains(string(w.last.eventPayload), "alice") {
		t.Fatalf("the event gives away more than the scope: %s", w.last.eventPayload)
	}
	if _, shared := w.public[keyMessage+deal.ID+"~"+msg.ID]; shared {
		t.Fatal("the private message is in the shared state")
	}

	// Bob reads it on Birch's peer.
	got := decode[thread](t, w.must(w.read(bob, pair, deal.ID, "")))
	if len(got.Messages) != 1 || got.Messages[0].Text != "our floor is 40" || got.Messages[0].Salt != "" {
		t.Fatalf("unexpected messages: %+v", got.Messages)
	}

	// Details passed as an ordinary argument would be written into the block for everyone.
	w.refuse("CHAT_BAD_INPUT")(w.as(alice, "", func(ctx ctxT) (string, error) {
		return chat.Post(ctx, pair, `{"convId":"`+deal.ID+`","text":"oops","salt":"`+salt+`"}`)
	}))
	// Without a salt, a short message could be guessed from its hash.
	w.refuse("CHAT_BAD_INPUT")(w.submit(alice, pair, chat.Post, `{"convId":"`+deal.ID+`","text":"yes"}`))
	// Cedar is not one of the companies that keep this scope.
	w.refuse("CHAT_WRONG_SCOPE")(w.read(carol, pair, deal.ID, ""))
	w.refuse("CHAT_WRONG_SCOPE")(w.submit(alice, pair, chat.AddMembers, `{"convId":"`+deal.ID+`","members":["`+carol+`"]}`))
	// Arjun's company keeps the scope, but he is not in this conversation.
	w.refuse("CHAT_NOT_MEMBER")(w.read(arjun, pair, deal.ID, ""))
}

func TestACompanysOwnCollectionIsForThatCompanyOnly(t *testing.T) {
	w := office(t)
	room := w.channel(alice, asters, "leadership", arjun)
	w.post(arjun, asters, room.ID, "board deck is ready")
	w.refuse("CHAT_WRONG_SCOPE")(w.read(bob, asters, room.ID, ""))
	w.refuse("CHAT_WRONG_SCOPE")(w.submit(alice, asters, chat.CreateConversation, `{"kind":"channel","name":"x","members":["`+bob+`"],"salt":"`+salt+`"}`))
	w.refuse("CHAT_BAD_SCOPE")(w.read(alice, "not a scope", room.ID, ""))
}

func TestDirectMessageNeedsAnotherPerson(t *testing.T) {
	w := office(t)
	w.refuse("CHAT_BAD_INPUT")(w.submit(alice, pair, chat.CreateConversation, `{"kind":"dm","members":[],"salt":"`+salt+`"}`))
	dm := decode[Conversation](t, w.must(w.submit(alice, pair, chat.CreateConversation, `{"kind":"dm","members":["`+bob+`"],"salt":"`+salt+`"}`)))
	if !strings.HasPrefix(dm.ID, "d-") || len(dm.Members) != 2 {
		t.Fatalf("unexpected direct message: %+v", dm)
	}
	w.refuse("CHAT_BAD_INPUT")(w.submit(alice, pair, chat.AddMembers, `{"convId":"`+dm.ID+`","members":["`+arjun+`"]}`))
}

func TestEditAndDeleteLeaveHistoryInThePublicScope(t *testing.T) {
	w := office(t)
	w.channel(alice, scopePublic, "general")
	msg := w.post(alice, scopePublic, "general", "the launch is on Tuseday")
	ref := fmt.Sprintf(`"convId":"general","msgId":%q`, msg.ID)

	w.refuse("CHAT_NOT_AUTHOR")(w.submit(bob, scopePublic, chat.Edit, `{`+ref+`,"text":"hacked"}`))
	w.refuse("CHAT_NO_CHANGE")(w.submit(alice, scopePublic, chat.Edit, `{`+ref+`,"text":"the launch is on Tuseday"}`))
	edited := decode[Message](t, w.must(w.submit(alice, scopePublic, chat.Edit, `{`+ref+`,"text":"the launch is on Tuesday"}`)))
	if edited.EditedAt == "" || edited.FirstTx != msg.TxID || edited.TxID == msg.TxID {
		t.Fatalf("an edit keeps the first transaction and records its own: %+v", edited)
	}
	w.refuse("CHAT_NOT_AUTHOR")(w.submit(bob, scopePublic, chat.Delete, `{`+ref+`}`))
	w.must(w.submit(alice, scopePublic, chat.Delete, `{`+ref+`}`))
	w.refuse("CHAT_GONE")(w.submit(alice, scopePublic, chat.Edit, `{`+ref+`,"text":"back again"}`))

	now := decode[thread](t, w.must(w.read(bob, scopePublic, "general", "")))
	if len(now.Messages) != 1 || !now.Messages[0].Deleted || now.Messages[0].Text != "" {
		t.Fatalf("a deleted public message stays as an empty marker: %+v", now.Messages)
	}
	// The ledger still has every version.
	versions := decode[[]version](t, w.must(w.as(bob, "", func(ctx ctxT) (string, error) { return chat.History(ctx, "general", msg.ID) })))
	if len(versions) != 3 || versions[0].Text != "the launch is on Tuseday" || versions[1].Text != "the launch is on Tuesday" || !versions[2].Deleted {
		t.Fatalf("unexpected history: %+v", versions)
	}
}

func TestDeleteInAPrivateScopePurges(t *testing.T) {
	w := office(t)
	deal := w.channel(alice, pair, "pricing", bob)
	msg := w.post(alice, pair, deal.ID, "ignore that last number")
	ref := fmt.Sprintf(`"convId":%q,"msgId":%q`, deal.ID, msg.ID)
	w.must(w.submit(bob, pair, chat.React, `{`+ref+`,"emoji":"eyes","on":true}`))
	key := keyMessage + deal.ID + "~" + msg.ID
	if w.private[pair][key] == nil || w.hashes[pair][key] == nil {
		t.Fatal("the message should be in the collection, and its hash with every peer")
	}

	w.must(w.submit(alice, pair, chat.Delete, `{`+ref+`,"reactions":[{"emoji":"eyes","by":"`+bob+`"}]}`))
	if w.private[pair][key] != nil {
		t.Fatal("the message is still in the collection after the purge")
	}
	left := decode[thread](t, w.must(w.read(bob, pair, deal.ID, "")))
	if len(left.Messages) != 0 || len(left.Reactions) != 0 {
		t.Fatalf("nothing should be left: %+v", left)
	}
}

func TestReactionsAreCountedPerPerson(t *testing.T) {
	w := office(t)
	w.channel(alice, scopePublic, "general")
	msg := w.post(alice, scopePublic, "general", "shipped")
	ref := fmt.Sprintf(`"convId":"general","msgId":%q`, msg.ID)
	for _, who := range []string{alice, bob, carol} {
		w.must(w.submit(who, scopePublic, chat.React, `{`+ref+`,"emoji":"tada","on":true}`))
	}
	w.must(w.submit(bob, scopePublic, chat.React, `{`+ref+`,"emoji":"tada","on":false}`))
	w.refuse("CHAT_BAD_INPUT")(w.submit(bob, scopePublic, chat.React, `{`+ref+`,"emoji":"NOT OK","on":true}`))

	got := decode[thread](t, w.must(w.read(bob, scopePublic, "general", "")))
	if strings.Join(got.Reactions[msg.ID]["tada"], ",") != alice+","+carol {
		t.Fatalf("unexpected reactions: %+v", got.Reactions)
	}
}

type holding struct {
	Held       bool   `json:"held"`
	HeldHash   string `json:"heldHash"`
	LedgerHash string `json:"ledgerHash"`
	Note       string `json:"note"`
}

func TestInspectShowsWhatEachCompanysPeerHolds(t *testing.T) {
	w := office(t)
	deal := w.channel(alice, pair, "pricing", bob)
	msg := w.post(alice, pair, deal.ID, "our floor is 40")
	key := keyMessage + deal.ID + "~" + msg.ID
	inspect := func(ctx ctxT) (string, error) { return chat.Inspect(ctx, pair, key) }

	aster := decode[holding](t, w.must(w.on("AsterMSP", alice, "", inspect)))
	birch := decode[holding](t, w.must(w.on("BirchMSP", bob, "", inspect)))
	cedar := decode[holding](t, w.must(w.on("CedarMSP", carol, "", inspect)))

	if !aster.Held || !birch.Held || aster.HeldHash != aster.LedgerHash || birch.HeldHash != aster.LedgerHash {
		t.Fatalf("both members should hold the message, matching the ledger's hash: %+v %+v", aster, birch)
	}
	// Cedar cannot read the message, and still holds the hash that proves what it said.
	if cedar.Held || cedar.HeldHash != "" || cedar.LedgerHash != aster.LedgerHash || cedar.Note == "" {
		t.Fatalf("Cedar should hold only the hash: %+v", cedar)
	}
}

func TestOverviewListsOnlyWhatTheCallerIsIn(t *testing.T) {
	w := office(t)
	w.channel(alice, scopePublic, "general")
	w.channel(alice, scopePublic, "launch", bob)
	deal := w.channel(alice, pair, "pricing", bob)
	w.channel(arjun, asters, "leadership")
	last := w.post(bob, pair, deal.ID, "agreed")

	scopes := `["public","` + pair + `","` + asters + `","_implicit_org_BirchMSP"]`
	views := decode[[]scopeView](t, w.must(w.as(alice, "", func(ctx ctxT) (string, error) { return chat.Overview(ctx, scopes) })))
	if len(views) != 4 || len(views[0].Conversations) != 2 || len(views[1].Conversations) != 1 {
		t.Fatalf("unexpected overview: %+v", views)
	}
	if got := views[1].Conversations[0]; got.LastMsg != last.ID || got.LastBy != bob || got.Salt != "" {
		t.Fatalf("the overview should point at the newest message: %+v", got)
	}
	// Arjun made #leadership for himself only, so Alice does not see it even though Aster keeps it.
	if len(views[2].Conversations) != 0 || views[2].Error != "" {
		t.Fatalf("Alice is not in #leadership: %+v", views[2])
	}
	// Birch's own collection is not Alice's to read. The other scopes are still answered.
	if !strings.HasPrefix(views[3].Error, "CHAT_WRONG_SCOPE") {
		t.Fatalf("expected an error for Birch's own collection: %+v", views[3])
	}
	carols := decode[[]scopeView](t, w.must(w.as(carol, "", func(ctx ctxT) (string, error) { return chat.Overview(ctx, `["public"]`) })))
	if len(carols[0].Conversations) != 1 || carols[0].Conversations[0].ID != "general" {
		t.Fatalf("Carol should see only #general: %+v", carols[0])
	}
}

// A company on its own server uses a domain name it owns as its ID, so its people read like
// email addresses. Everything works the same, and its own collection is named after that ID.
func TestACompanyIDCanBeADomainName(t *testing.T) {
	const (
		dana  = "dana@dune.example"
		dev   = "dev@dune.example"
		eve   = "eve@dune.example"
		dunes = "_implicit_org_dune.example"
	)
	w := newWorld(t)
	for _, who := range []string{dana, dev, eve} {
		w.must(w.as(who, "", func(ctx ctxT) (string, error) { return chat.Join(ctx, `{"name":"`+who[:strings.Index(who, "@")]+`"}`) }))
	}
	me := decode[map[string]interface{}](t, w.must(w.as(dana, "", func(ctx ctxT) (string, error) { return chat.Whoami(ctx) })))
	if me["id"] != dana || me["msp"] != "dune.example" {
		t.Fatalf("the caller should be read as %s: %+v", dana, me)
	}
	w.channel(dana, scopePublic, "general")
	w.post(dev, scopePublic, "general", "morning")

	ops := w.channel(dana, dunes, "ops", dev)
	msg := w.post(dana, dunes, ops.ID, "the depot code is 4417")
	got := decode[thread](t, w.must(w.read(dev, dunes, ops.ID, "")))
	if len(got.Messages) != 1 || got.Messages[0].Author != dana {
		t.Fatalf("the other member should read it: %+v", got.Messages)
	}
	// Eve works at the same company, so its peer holds the conversation. She is still not in it.
	w.refuse("CHAT_NOT_MEMBER")(w.read(eve, dunes, ops.ID, ""))
	w.must(w.submit(dana, dunes, chat.Delete, fmt.Sprintf(`{"convId":%q,"msgId":%q}`, ops.ID, msg.ID)))
	if w.private[dunes][keyMessage+ops.ID+"~"+msg.ID] != nil {
		t.Fatal("the message is still in the collection after the purge")
	}

	// A shared collection is named by joining plain company IDs with "-". A domain name may hold a
	// dash itself, so it cannot be told apart there, and is refused rather than guessed at.
	w.refuse("CHAT_BAD_SCOPE")(w.read(dana, "dune.example-birch.example", ops.ID, ""))
	w.refuse("CHAT_BAD_SCOPE")(w.read(dana, "_implicit_org_.example", ops.ID, ""))
	w.refuse("CHAT_BAD_INPUT")(w.submit(dana, dunes, chat.AddMembers, `{"convId":"`+ops.ID+`","members":["someone@-bad-"]}`))
}
