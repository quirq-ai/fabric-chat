package main

import (
	"fmt"
	"regexp"
	"strings"
)

// A scope is where a conversation is kept. It decides which companies' peers store the text.
//
//	public                    the channel's shared state: every member company's peer stores it
//	AsterMSP-BirchMSP         a private data collection: only those companies' peers store it
//	_implicit_org_AsterMSP    one company's own collection, which Fabric gives every member for free
//
// For the two private kinds, the other companies' peers and the orderers receive only a hash.
const (
	scopePublic    = "public"
	implicitPrefix = "_implicit_org_"
)

const (
	maxText    = 4000
	maxName    = 40
	maxTopic   = 120
	maxMembers = 50
	timeLayout = "2006-01-02T15:04:05.000Z"
)

// Keys are plain text with "~" between the parts, so they read well in CouchDB and in a block.
// CouchDB does not allow a key to start with an underscore.
const (
	keyProfile  = "profile~" // profile~alice@AsterMSP
	keyConv     = "conv~"    // conv~general
	keyHead     = "head~"    // head~general
	keyMessage  = "msg~"     // msg~general~1763000000000-1a2b3c4d
	keyReaction = "react~"   // react~general~1763000000000-1a2b3c4d~thumbsup~alice@AsterMSP
)

var (
	handleRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)
	mspRe    = regexp.MustCompile(`^[A-Za-z0-9]{1,64}$`)
	userRe   = regexp.MustCompile(`^([a-z0-9][a-z0-9._-]{0,31})@([A-Za-z0-9]{1,64})$`)
	convRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
	msgRe    = regexp.MustCompile(`^[0-9]{13}-[0-9a-f]{8}$`)
	emojiRe  = regexp.MustCompile(`^[a-z0-9_+-]{1,24}$`)
)

// Profile is one person's entry in a workspace's directory. The ID comes from their certificate:
// the name the company's CA signed, and the company (MSP) that CA belongs to.
type Profile struct {
	DocType  string `json:"docType"`
	ID       string `json:"id"` // alice@AsterMSP
	Handle   string `json:"handle"`
	MSP      string `json:"msp"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	JoinedAt string `json:"joinedAt"`
	TxID     string `json:"txId"`
}

// Conversation is a channel or a direct message.
type Conversation struct {
	DocType   string   `json:"docType"`
	ID        string   `json:"id"`
	Scope     string   `json:"scope"`
	Kind      string   `json:"kind"` // channel or dm
	Name      string   `json:"name"`
	Topic     string   `json:"topic"`
	Members   []string `json:"members"` // empty: open to everyone in the workspace
	CreatedBy string   `json:"createdBy"`
	CreatedAt string   `json:"createdAt"`
	TxID      string   `json:"txId"`
	Salt      string   `json:"salt,omitempty"`
}

// Message is one message as it stands now. Earlier versions stay in the ledger's history.
type Message struct {
	DocType  string `json:"docType"`
	ID       string `json:"id"`
	ConvID   string `json:"convId"`
	Author   string `json:"author"`
	Text     string `json:"text"`
	SentAt   string `json:"sentAt"`
	EditedAt string `json:"editedAt,omitempty"`
	Deleted  bool   `json:"deleted,omitempty"`
	TxID     string `json:"txId"`    // the transaction that wrote this version
	FirstTx  string `json:"firstTx"` // the transaction that first posted it
	// In a private scope everyone on the channel sees the hash of this record. A random salt keeps
	// a short message ("yes", "no") from being guessed by hashing likely texts.
	Salt string `json:"salt,omitempty"`
}

// Head points at a conversation's newest message. Every post overwrites it without reading it
// first, so two people posting at the same moment never make each other's transaction fail.
type Head struct {
	ConvID  string `json:"convId"`
	LastAt  string `json:"lastAt"`
	LastBy  string `json:"lastBy"`
	LastMsg string `json:"lastMsg"`
}

func (c *Conversation) open() bool { return len(c.Members) == 0 }

func (c *Conversation) has(user string) bool { return c.open() || contains(c.Members, user) }

// fail makes an error whose text starts with a code the app can read, for example CHAT_NOT_MEMBER.
func fail(code, format string, a ...interface{}) error {
	return fmt.Errorf("%s: %s", code, fmt.Sprintf(format, a...))
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// short trims a one-line value such as a name, and cuts it to max characters.
func short(text string, max int) string {
	return cut(strings.Join(strings.Fields(text), " "), max)
}

// body trims a message's text, keeping its line breaks.
func body(text string) string {
	return cut(strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n")), maxText)
}

func cut(text string, max int) string {
	runes := []rune(text)
	if len(runes) > max {
		return string(runes[:max])
	}
	return text
}

// slug turns "Q3 Pricing!" into "q3-pricing", the form a channel name is kept in.
func slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			dash = false
		case b.Len() > 0 && !dash:
			b.WriteRune('-')
			dash = true
		}
	}
	return strings.Trim(cut(b.String(), maxName), "-")
}
