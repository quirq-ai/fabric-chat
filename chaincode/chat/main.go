package main

import (
	"log"
	"os"

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
	if address := os.Getenv("CHAINCODE_SERVER_ADDRESS"); address != "" {
		server := &shim.ChaincodeServer{
			CCID:     os.Getenv("CHAINCODE_ID"),
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
