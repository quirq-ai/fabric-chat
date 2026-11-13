#!/bin/bash
# Shared by the ctl commands: reads and checks company.json, and names the folders each command
# works in. Every folder below is a Docker volume on the company's own server.
set -euo pipefail

COMPANY_FILE="${COMPANY_FILE:-/company/company.json}"
NODE=/node          # keys, certificates and first blocks for this company's nodes
APP=/app-config     # what the chat app may read: the facts about the node, and the app's own identities
CA_HOME=/ca         # the certificate authority's own folder, with the company's root key
RULES=/rules        # the ID of the chaincode package, read by the chaincode container
DESK=/desk          # where the chat app leaves requests for the node, and reads the answers
CA_URL="ca:7054"

WORKSPACES="$NODE/workspaces" # one folder per workspace this company is on: its first block and who is in it
COMPANIES="$NODE/companies"   # one folder per company whose card is known here. Cards hold nothing secret

# The home workspace: a channel only this company is on.
CHANNEL=home
CC_NAME=chat
CC_VERSION=1.0
CC_SEQUENCE=1

# The handles the node itself uses at the certificate authority. A person cannot have one of them.
NODE_HANDLES="registrar people-registrar chat-service node-admin peer orderer"

fail() {
  echo "$*" >&2
  exit 1
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

# secret <file>: make a random password in the file, unless it already holds one.
secret() {
  if [ ! -s "$1" ]; then
    head -c 30 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' >"$1"
  fi
}

HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
HANDLE_RE='^[a-z0-9][a-z0-9._-]{0,31}$'

# Tells Fabric how to read a role from a certificate: the OU the authority wrote into it.
node_ous() {
  cat >"$1/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/ca-cert.pem
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/ca-cert.pem
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/ca-cert.pem
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/ca-cert.pem
    OrganizationalUnitIdentifier: orderer
EOF
}

# read_company [file | -]: check company.json and set COMPANY_ID, COMPANY_NAME and the rest.
# "-" reads it from standard input.
read_company() {
  local source="${1:-$COMPANY_FILE}" json
  if [ "$source" = "-" ]; then
    json="$(cat)"
  else
    [ -f "$source" ] || fail "company.json was not found. It belongs in the same folder as compose.yaml."
    json="$(cat "$source")"
  fi
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$json" || fail "company.json is not valid JSON. Check for a missing comma or quote."

  get() { jq -r "($1) // empty | tostring" <<<"$json"; }
  wrong() { fail "company.json: $*"; }

  COMPANY_NAME="$(get .name)"
  COMPANY_ID="$(get .id)"
  COMPANY_COLOR="$(get .color)"
  CHAT_HOST="$(get .hosts.chat)"
  PEER_HOST="$(get .hosts.peer)"
  ORDERER_HOST="$(get .hosts.orderer)"
  ADMIN_HANDLE="$(get .admin.handle)"
  ADMIN_NAME="$(get .admin.name)"
  ADMIN_TITLE="$(get .admin.title)"
  LISTEN_ADDRESS="$(get .listen.address)"
  LISTEN_PORT="$(get .listen.port)"
  RELEASE_WANTED="$(get .release)"
  IMAGES="$(get .images)"
  DOCKER_NETWORK="$(get .dockerNetwork)"
  NODE_ADDRESS="$(get .node.address)"
  # "https" is one word, or a block for a company that uses a certificate authority of its own.
  HTTPS="$(get '.https | if type == "object" then (.certificate // "auto") else . end')"
  HTTPS_AUTHORITY="$(get '.https | objects | .authority')"
  HTTPS_EMAIL="$(get '.https | objects | .email')"
  HTTPS_ROOT="$(jq -r '.https | objects | .root // empty' <<<"$json")"

  : "${HTTPS:=off}"
  # Plain HTTP answers on a port of this machine. HTTPS answers where browsers look for it.
  if [ -z "$LISTEN_PORT" ]; then
    if [ "$HTTPS" = off ]; then LISTEN_PORT=8080; else LISTEN_PORT=443; fi
  fi
  if [ -z "$LISTEN_ADDRESS" ]; then
    if [ "$HTTPS" = off ]; then LISTEN_ADDRESS=127.0.0.1; else LISTEN_ADDRESS=0.0.0.0; fi
  fi
  : "${COMPANY_COLOR:=#4b6bfb}" "${IMAGES:=fabric-chat}"
  : "${RELEASE_WANTED:=${RELEASE:-dev}}"

  [ -n "$COMPANY_NAME" ] || wrong '"name" is missing. It is the company'"'"'s name as people will see it, for example "Aster Labs".'
  [ "${#COMPANY_NAME}" -le 60 ] || wrong '"name" is longer than 60 characters.'

  [ -n "$COMPANY_ID" ] || wrong '"id" is missing. Use a domain name your company owns, for example "aster.example".'
  [[ "$COMPANY_ID" =~ $HOST_RE ]] && [[ "$COMPANY_ID" == *.* ]] && [ "${#COMPANY_ID}" -le 64 ] ||
    wrong "\"id\" is \"$COMPANY_ID\". It must be a domain name your company owns, in lower case and at most 64 characters, for example \"aster.example\"."

  local name value
  for name in chat peer orderer; do
    case "$name" in
      chat) value="$CHAT_HOST" ;;
      peer) value="$PEER_HOST" ;;
      orderer) value="$ORDERER_HOST" ;;
    esac
    [ -n "$value" ] || wrong "\"hosts.$name\" is missing. It is the name this server answers to for its $name, for example \"$name.$COMPANY_ID\"."
    [[ "$value" =~ $HOST_RE ]] && [ "${#value}" -le 253 ] || wrong "\"hosts.$name\" is \"$value\", which is not a host name."
  done

  [ -n "$ADMIN_HANDLE" ] || wrong '"admin.handle" is missing. It is the first administrator'"'"'s short name, for example "alice".'
  [[ "$ADMIN_HANDLE" =~ $HANDLE_RE ]] || wrong "\"admin.handle\" is \"$ADMIN_HANDLE\". Use lower-case letters, digits, dot, dash or underscore, at most 32 characters."
  for name in $NODE_HANDLES admin root system service; do
    [ "$ADMIN_HANDLE" != "$name" ] || wrong "\"admin.handle\" cannot be \"$name\": the node uses that name itself."
  done
  [ -n "$ADMIN_NAME" ] || wrong '"admin.name" is missing. It is the first administrator'"'"'s full name, for example "Alice Ahn".'
  [ "${#ADMIN_NAME}" -le 40 ] || wrong '"admin.name" is longer than 40 characters.'
  [ "${#ADMIN_TITLE}" -le 40 ] || wrong '"admin.title" is longer than 40 characters.'

  [[ "$COMPANY_COLOR" =~ ^#[0-9a-fA-F]{6}$ ]] || wrong "\"color\" is \"$COMPANY_COLOR\". Use six hex digits, for example \"#6c5ce7\"."
  [[ "$LISTEN_ADDRESS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || wrong "\"listen.address\" is \"$LISTEN_ADDRESS\". Use 127.0.0.1 for this machine only, or 0.0.0.0 for every network."
  [[ "$LISTEN_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$LISTEN_PORT" -ge 1 ] && [ "$LISTEN_PORT" -le 65535 ] || wrong "\"listen.port\" is \"$LISTEN_PORT\". Use a port number from 1 to 65535."
  [[ "$RELEASE_WANTED" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,40}$ ]] || wrong "\"release\" is \"$RELEASE_WANTED\", which is not a version such as 0.3.0."
  [[ "$IMAGES" =~ ^[a-z0-9][a-z0-9._/:-]{0,200}$ ]] || wrong "\"images\" is \"$IMAGES\". It is where the images come from, for example \"ghcr.io/quirq-ai/fabric-chat\"."

  [ -z "$DOCKER_NETWORK" ] || [[ "$DOCKER_NETWORK" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$ ]] ||
    wrong "\"dockerNetwork\" is \"$DOCKER_NETWORK\", which is not the name of a Docker network. Leave it out on a server of its own."

  [ -z "$NODE_ADDRESS" ] || [[ "$NODE_ADDRESS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
    wrong "\"node.address\" is \"$NODE_ADDRESS\". It is the address of this server on which other companies' servers reach its node: 0.0.0.0 for every network. Leave it out to keep the node closed."

  case "$HTTPS" in
    off | auto | self-signed) ;;
    *) wrong "\"https\" is \"$HTTPS\". Use \"auto\" for a certificate from Let's Encrypt, \"self-signed\" to try HTTPS on a private network, or leave it out for plain HTTP." ;;
  esac
  if [ "$HTTPS" = auto ] && [ -z "$HTTPS_AUTHORITY" ]; then
    # Let's Encrypt proves a name by calling the server that claims it, on port 443 or 80 and nowhere else.
    [ "$LISTEN_PORT" = 443 ] || wrong "\"https\" is \"auto\" and \"listen.port\" is $LISTEN_PORT. Let's Encrypt checks a server on port 443: set \"listen.port\" to 443, or leave \"listen\" out."
    [ "$LISTEN_ADDRESS" != 127.0.0.1 ] || wrong "\"https\" is \"auto\" and \"listen.address\" is 127.0.0.1. Let's Encrypt has to reach this server from outside: set \"listen.address\" to 0.0.0.0, or leave \"listen\" out."
  fi
  [ -z "$HTTPS_AUTHORITY" ] || [[ "$HTTPS_AUTHORITY" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] ||
    wrong "\"https.authority\" is \"$HTTPS_AUTHORITY\". It is the address of a certificate authority's ACME directory, starting with https://."
  [ -z "$HTTPS_EMAIL" ] || [[ "$HTTPS_EMAIL" =~ ^[^[:space:]@]+@[A-Za-z0-9.-]+$ ]] || wrong "\"https.email\" is \"$HTTPS_EMAIL\", which is not an email address."
  [ -z "$HTTPS_ROOT" ] || grep -q -- '-----BEGIN CERTIFICATE-----' <<<"$HTTPS_ROOT" || wrong "\"https.root\" is not a certificate. It is the root certificate of \"https.authority\", as text starting with -----BEGIN CERTIFICATE-----."

  # Where people open the chat. Links the server hands out, such as a new person's, start with it.
  if [ "$HTTPS" = off ]; then
    CHAT_ORIGIN="http://localhost:$LISTEN_PORT"
  else
    CHAT_ORIGIN="https://$CHAT_HOST"
    [ "$LISTEN_PORT" = 443 ] || CHAT_ORIGIN="$CHAT_ORIGIN:$LISTEN_PORT"
  fi

  # Docker Compose names this company's containers, volumes and network after this.
  PROJECT="chat-${COMPANY_ID//./-}"
}

# Act as this company's node administrator, talking to its own peer and its own orderer.
use_admin() {
  export CORE_PEER_LOCALMSPID="$COMPANY_ID"
  export CORE_PEER_ADDRESS="$PEER_HOST:7051"
  export CORE_PEER_MSPCONFIGPATH="$NODE/admin/msp"
  export CORE_PEER_TLS_ROOTCERT_FILE="$NODE/ca-cert.pem"
  export CORE_PEER_TLS_ENABLED=true
  export FABRIC_CFG_PATH=/etc/hyperledger/fabric
  ORDERER=(-o "$ORDERER_HOST:7050" --tls --cafile "$NODE/ca-cert.pem")
  # The orderer's admin port accepts only a caller holding a certificate from this company's authority.
  ORDERER_ADMIN=(-o "$ORDERER_HOST:7053" --ca-file "$NODE/ca-cert.pem" --client-cert "$NODE/admin/tls/server.crt" --client-key "$NODE/admin/tls/server.key")
}
