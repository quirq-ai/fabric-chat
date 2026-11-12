package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/queryresult"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// world is a pretend channel, enough of Fabric to test the chaincode's rules without a network.
// It keeps the shared state, each private collection, the hashes every peer would hold, and the
// history of the shared state. It also applies the rules of Fabric that the design leans on:
// a transaction's writes land only if it succeeds, a peer outside a collection cannot read it, and
// a transaction may not search a collection and write to it as well.
type world struct {
	t       *testing.T
	public  map[string][]byte
	private map[string]map[string][]byte
	hashes  map[string]map[string][]byte
	history map[string][]*queryresult.KeyModification
	clock   int64
	seq     int
	last    *fakeStub // the most recent transaction, for looking at what it did
}

func newWorld(t *testing.T) *world {
	return &world{
		t: t, public: map[string][]byte{}, private: map[string]map[string][]byte{},
		hashes: map[string]map[string][]byte{}, history: map[string][]*queryresult.KeyModification{},
		clock: 1763000000000,
	}
}

type call func(ctx contractapi.TransactionContextInterface) (string, error)

// as runs one transaction signed by who (for example alice@AsterMSP) on their own company's peer.
// transient is the private payload, or "" for none.
func (w *world) as(who, transient string, fn call) (string, error) {
	return w.on(strings.SplitN(who, "@", 2)[1], who, transient, fn)
}

// on runs one transaction signed by who, on the peer of the company peerMSP.
func (w *world) on(peerMSP, who, transient string, fn call) (string, error) {
	parts := strings.SplitN(who, "@", 2)
	w.seq++
	w.clock += 250
	sum := sha256.Sum256([]byte(fmt.Sprint(w.seq)))
	stub := &fakeStub{
		w: w, peerMSP: peerMSP, clientMSP: parts[1], txID: hex.EncodeToString(sum[:]),
		publicWrites: map[string]*[]byte{}, privateWrites: map[string]map[string]*[]byte{}, purges: map[string][]string{},
		transient: map[string][]byte{},
	}
	if transient != "" {
		stub.transient["payload"] = []byte(transient)
	}
	w.last = stub
	out, err := fn(&fakeCtx{stub: stub, id: &fakeIdentity{handle: parts[0], msp: parts[1]}})
	if err == nil {
		stub.commit()
	}
	return out, err
}

type fakeCtx struct {
	stub *fakeStub
	id   *fakeIdentity
}

func (c *fakeCtx) GetStub() shim.ChaincodeStubInterface  { return c.stub }
func (c *fakeCtx) GetClientIdentity() cid.ClientIdentity { return c.id }

type fakeIdentity struct{ handle, msp string }

func (i *fakeIdentity) GetID() (string, error)    { return "x509::CN=" + i.handle, nil }
func (i *fakeIdentity) GetMSPID() (string, error) { return i.msp, nil }
func (i *fakeIdentity) GetAttributeValue(string) (string, bool, error) {
	return "", false, nil
}
func (i *fakeIdentity) AssertAttributeValue(string, string) error { return errors.New("no attributes") }
func (i *fakeIdentity) GetX509Certificate() (*x509.Certificate, error) {
	return &x509.Certificate{Subject: pkix.Name{CommonName: i.handle, OrganizationalUnit: []string{"client"}}}, nil
}

// fakeStub is one transaction. Any stub method the chaincode calls that is not written here panics,
// which is how a test finds out the chaincode started using something new.
type fakeStub struct {
	shim.ChaincodeStubInterface
	w                  *world
	peerMSP, clientMSP string
	txID               string
	transient          map[string][]byte
	publicWrites       map[string]*[]byte            // nil pointer value = delete
	privateWrites      map[string]map[string]*[]byte // collection -> key -> value or delete
	purges             map[string][]string
	publicReads        []string
	wrote, searched    bool
	eventName          string
	eventPayload       []byte
}

func (s *fakeStub) GetTxID() string { return s.txID }

func (s *fakeStub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	return &timestamppb.Timestamp{Seconds: s.w.clock / 1000, Nanos: int32(s.w.clock%1000) * 1e6}, nil
}

func (s *fakeStub) GetTransient() (map[string][]byte, error) { return s.transient, nil }

func (s *fakeStub) SetEvent(name string, payload []byte) error {
	s.eventName, s.eventPayload = name, payload
	return nil
}

// asCouchDB returns a stored value the way a peer backed by CouchDB does: a JSON record comes back
// with its keys in alphabetical order, whatever order it was written in.
func asCouchDB(value []byte) []byte {
	var plain interface{}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	if value == nil || decoder.Decode(&plain) != nil {
		return value
	}
	out, _ := json.Marshal(plain)
	return out
}

func (s *fakeStub) GetState(key string) ([]byte, error) {
	s.publicReads = append(s.publicReads, key)
	return asCouchDB(s.w.public[key]), nil
}

func (s *fakeStub) PutState(key string, value []byte) error {
	s.wrote = true
	s.publicWrites[key] = &value
	return nil
}

func (s *fakeStub) DelState(key string) error {
	s.wrote = true
	s.publicWrites[key] = nil
	return nil
}

func (s *fakeStub) GetStateByRange(start, end string) (shim.StateQueryIteratorInterface, error) {
	s.publicReads = append(s.publicReads, start+"..")
	return rangeOf(s.w.public, start, end), nil
}

// readable applies Fabric's two checks on a private read: the peer must be one that stores the
// collection, and (memberOnlyRead) the caller's company must be a member too.
func (s *fakeStub) readable(collection string) error {
	sc, err := parseScope(collection)
	if err != nil || !sc.private() {
		return fmt.Errorf("collection %s is not defined", collection)
	}
	if !contains(sc.orgs, s.peerMSP) {
		return fmt.Errorf("private data matching public hash version is not available on this peer")
	}
	if !contains(sc.orgs, s.clientMSP) {
		return fmt.Errorf("tx creator does not have read access permission on privatedata in collection %s", collection)
	}
	return nil
}

func (s *fakeStub) GetPrivateData(collection, key string) ([]byte, error) {
	if err := s.readable(collection); err != nil {
		return nil, err
	}
	return asCouchDB(s.w.private[collection][key]), nil
}

func (s *fakeStub) GetPrivateDataHash(collection, key string) ([]byte, error) {
	return s.w.hashes[collection][key], nil
}

func (s *fakeStub) GetPrivateDataByRange(collection, start, end string) (shim.StateQueryIteratorInterface, error) {
	if err := s.readable(collection); err != nil {
		return nil, err
	}
	if s.wrote {
		return nil, errors.New("queries on pvt data is supported only in a read-only transaction")
	}
	s.searched = true
	return rangeOf(s.w.private[collection], start, end), nil
}

func (s *fakeStub) privateWrite(collection, key string, value *[]byte) error {
	if s.searched {
		return errors.New("transaction has already performed queries on pvt data. Writes are not allowed")
	}
	s.wrote = true
	if s.privateWrites[collection] == nil {
		s.privateWrites[collection] = map[string]*[]byte{}
	}
	s.privateWrites[collection][key] = value
	return nil
}

func (s *fakeStub) PutPrivateData(collection, key string, value []byte) error {
	return s.privateWrite(collection, key, &value)
}

func (s *fakeStub) DelPrivateData(collection, key string) error {
	return s.privateWrite(collection, key, nil)
}

func (s *fakeStub) PurgePrivateData(collection, key string) error {
	if s.searched {
		return errors.New("transaction has already performed queries on pvt data. Writes are not allowed")
	}
	s.wrote = true
	s.purges[collection] = append(s.purges[collection], key)
	return nil
}

func (s *fakeStub) GetHistoryForKey(key string) (shim.HistoryQueryIteratorInterface, error) {
	// Fabric returns the newest version first.
	mods := append([]*queryresult.KeyModification{}, s.w.history[key]...)
	for i, j := 0, len(mods)-1; i < j; i, j = i+1, j-1 {
		mods[i], mods[j] = mods[j], mods[i]
	}
	return &historyIter{items: mods}, nil
}

// commit applies the transaction's writes, as a peer does once the block is validated.
func (s *fakeStub) commit() {
	ts, _ := s.GetTxTimestamp()
	for key, value := range s.publicWrites {
		mod := &queryresult.KeyModification{TxId: s.txID, Timestamp: ts}
		if value == nil {
			delete(s.w.public, key)
			mod.IsDelete = true
		} else {
			s.w.public[key] = *value
			mod.Value = *value
		}
		s.w.history[key] = append(s.w.history[key], mod)
	}
	for collection, writes := range s.privateWrites {
		if s.w.private[collection] == nil {
			s.w.private[collection] = map[string][]byte{}
			s.w.hashes[collection] = map[string][]byte{}
		}
		for key, value := range writes {
			if value == nil {
				delete(s.w.private[collection], key)
				delete(s.w.hashes[collection], key)
				continue
			}
			sum := sha256.Sum256(*value)
			s.w.private[collection][key] = *value
			s.w.hashes[collection][key] = sum[:]
		}
	}
	for collection, keys := range s.purges {
		for _, key := range keys {
			delete(s.w.private[collection], key)
			delete(s.w.hashes[collection], key)
		}
	}
}

func rangeOf(state map[string][]byte, start, end string) *stateIter {
	keys := make([]string, 0, len(state))
	for key := range state {
		if key >= start && (end == "" || key < end) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	it := &stateIter{}
	for _, key := range keys {
		it.items = append(it.items, &queryresult.KV{Key: key, Value: state[key]})
	}
	return it
}

type stateIter struct {
	items []*queryresult.KV
	next  int
}

func (it *stateIter) HasNext() bool { return it.next < len(it.items) }
func (it *stateIter) Close() error  { return nil }
func (it *stateIter) Next() (*queryresult.KV, error) {
	it.next++
	return it.items[it.next-1], nil
}

type historyIter struct {
	items []*queryresult.KeyModification
	next  int
}

func (it *historyIter) HasNext() bool { return it.next < len(it.items) }
func (it *historyIter) Close() error  { return nil }
func (it *historyIter) Next() (*queryresult.KeyModification, error) {
	it.next++
	return it.items[it.next-1], nil
}
