#!/bin/bash
# Shared by the scripts that run inside the tools container. The facts about the network come from
# /work/net.env, which network/generate.mjs writes.
set -euo pipefail
source /work/net.env

# Act as one company's administrator, talking to that company's own peer and its own orderer.
use_org() {
  local code="$1"
  local domain="${ORG_DOMAIN[$code]:-}"
  if [ -z "$domain" ]; then
    echo "Unknown company: $code. Known: ${ORGS[*]}" >&2
    return 1
  fi
  local peer="${ORG_PEER[$code]}"
  local orderer="${ORG_ORDERER[$code]}"
  export CORE_PEER_LOCALMSPID="${ORG_MSP[$code]}"
  export CORE_PEER_ADDRESS="$peer:7051"
  export CORE_PEER_MSPCONFIGPATH="/work/crypto-config/peerOrganizations/$domain/users/Admin@$domain/msp"
  export CORE_PEER_TLS_ROOTCERT_FILE="/work/crypto-config/peerOrganizations/$domain/peers/$peer/tls/ca.crt"
  export CORE_PEER_TLS_ENABLED=true
  export FABRIC_CFG_PATH=/etc/hyperledger/fabric
  ORDERER_ENDPOINT="$orderer:7050"
  ORDERER_CA="/work/crypto-config/ordererOrganizations/${ORG_ORDERER_DOMAIN[$code]}/orderers/$orderer/tls/ca.crt"
}

# The TLS files of one company's orderer. Its admin port accepts only a caller holding these.
orderer_tls() {
  local code="$1"
  echo "/work/crypto-config/ordererOrganizations/${ORG_ORDERER_DOMAIN[$code]}/orderers/${ORG_ORDERER[$code]}/tls"
}

# retry <tries> <command...>: run the command until it succeeds, two seconds apart.
retry() {
  local tries="$1"
  shift
  local n=1
  until "$@"; do
    if [ "$n" -ge "$tries" ]; then
      return 1
    fi
    n=$((n + 1))
    sleep 2
  done
}
