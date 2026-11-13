package main

import (
	"log"
	"os"
	"strings"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

func main() {
	chaincode, err := contractapi.NewChaincode(&Chat{})
	if err != nil {
		log.Fatalf("the chat chaincode could not be built: %v", err)
	}

	// Chaincode as a service: this program listens, and each company's peer connects to its own
	// copy. CHAINCODE_ID is the package ID the peers were given when the package was installed.
	// A company's own server keeps that ID in a file instead, written when the package was made.
	if address := os.Getenv("CHAINCODE_SERVER_ADDRESS"); address != "" {
		id := os.Getenv("CHAINCODE_ID")
		if file := os.Getenv("CHAINCODE_ID_FILE"); id == "" && file != "" {
			raw, err := os.ReadFile(file)
			if err != nil {
				log.Fatalf("the chaincode package ID could not be read: %v", err)
			}
			id = strings.TrimSpace(string(raw))
		}
		server := &shim.ChaincodeServer{
			CCID:     id,
			Address:  address,
			CC:       chaincode,
			TLSProps: shim.TLSProperties{Disabled: true},
		}
		log.Printf("chat chaincode %s listening on %s", server.CCID, address)
		if err := server.Start(); err != nil {
			log.Fatalf("the chat chaincode stopped: %v", err)
		}
		return
	}

	// Otherwise run the classic way, started by a peer.
	if err := chaincode.Start(); err != nil {
		log.Fatalf("the chat chaincode stopped: %v", err)
	}
}
