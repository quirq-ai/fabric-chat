#!/bin/bash
# ctl env: reads company.json on standard input, checks it, and prints the .env file Docker Compose
# reads. Nothing here is secret: passwords and keys are made later and never leave their volumes.
source "$(dirname "$0")/lib.sh"
read_company -

# The chat script and compose.yaml in a company's folder belong to a release, like the images.
# ./chat says which template it is, and a release that needs a newer one says so plainly.
TEMPLATE_NEEDED=3
if [ "${CHAT_TEMPLATE:-}" != "$TEMPLATE_NEEDED" ]; then
  fail "The files in this folder are older than release $RELEASE_WANTED.
Replace \"chat\" and \"compose.yaml\" with the ones that come with release $RELEASE_WANTED, then run ./chat up again. company.json stays as it is."
fi

# The proxy that answers over HTTPS is a part of compose.yaml that is only switched on when asked for.
profiles=""
if [ "$HTTPS" != off ]; then
  profiles="https"
fi

cat <<EOF
# Written by ./chat from company.json. Do not edit it: change company.json and run ./chat up again.
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=compose.yaml:compose.generated.yaml
COMPOSE_PROFILES=$profiles
TEMPLATE=$TEMPLATE_NEEDED
COMPANY_ID=$COMPANY_ID
CHAT_HOST=$CHAT_HOST
PEER_HOST=$PEER_HOST
ORDERER_HOST=$ORDERER_HOST
CHAT_BIND=$LISTEN_ADDRESS
CHAT_PORT=$LISTEN_PORT
CHAT_HTTPS=$HTTPS
CHAT_ORIGIN=$CHAT_ORIGIN
NODE_BIND=$NODE_ADDRESS
DOCKER_NETWORK=$DOCKER_NETWORK
IMAGES=$IMAGES
RELEASE=$RELEASE_WANTED
FABRIC_VERSION=$FABRIC_VERSION
CA_VERSION=$CA_VERSION
COUCHDB_VERSION=$COUCHDB_VERSION
EOF
