#!/bin/bash
# ctl compose: reads company.json on standard input and prints compose.generated.yaml, the part of
# the Docker Compose project that depends on the company's settings. compose.yaml says what runs.
# This file says what is opened to the world outside this server, and nothing is unless it is here:
#
#   the chat      plain HTTP on one port, or HTTPS through the proxy
#   the node      closed, or its three ports opened for other companies' servers
#   one machine   several companies on one machine join a Docker network that stands in for the internet
source "$(dirname "$0")/lib.sh"
read_company -

echo "# Written by ./chat from company.json. Do not edit it: change company.json and run ./chat up again."
echo "services:"

if [ "$HTTPS" = off ]; then
  cat <<EOF
  # The chat answers over plain HTTP. Keep it on 127.0.0.1 or a private network.
  app:
    ports:
      - "$LISTEN_ADDRESS:$LISTEN_PORT:8080"
EOF
else
  cat <<EOF
  # The chat answers over HTTPS at $CHAT_ORIGIN. The app itself is not published.
  proxy:
    ports:
      - "$LISTEN_ADDRESS:$LISTEN_PORT:443"
EOF
  if [ "$LISTEN_PORT" = 443 ]; then
    # Port 80 sends a browser that asked for plain HTTP on to HTTPS, and lets the certificate
    # authority check that this server answers to the name.
    echo "      - \"$LISTEN_ADDRESS:80:80\""
  fi
fi

if [ -n "$NODE_ADDRESS" ] || [ -n "$DOCKER_NETWORK" ]; then
  echo "  # Other companies' peers and orderers reach this company's node here."
  echo "  peer:"
  if [ -n "$NODE_ADDRESS" ]; then
    printf '    ports:\n      - "%s:7051:7051"\n' "$NODE_ADDRESS"
  fi
  if [ -n "$DOCKER_NETWORK" ]; then
    printf '    networks:\n      together:\n        aliases: ["%s"]\n' "$PEER_HOST"
  fi
  echo "  orderer:"
  if [ -n "$NODE_ADDRESS" ]; then
    printf '    ports:\n      - "%s:7050:7050"\n      - "%s:7055:7055"\n' "$NODE_ADDRESS" "$NODE_ADDRESS"
  fi
  if [ -n "$DOCKER_NETWORK" ]; then
    printf '    networks:\n      together:\n        aliases: ["%s"]\n' "$ORDERER_HOST"
  fi
fi

if [ -n "$DOCKER_NETWORK" ]; then
  cat <<EOF
  # The agent asks the other companies' peers to endorse the rules of a shared workspace.
  agent:
    networks:
      default: {}
      together: {}

# Several companies on one machine. On the internet each company's peer and orderer are reached by
# their own names. On one machine there is no such thing, so the companies' nodes all join one
# extra Docker network, where each is known by the name its company.json gives it. Nothing else
# joins it: every company's certificate authority, database, chat app and keys stay on its own network.
networks:
  together:
    name: $DOCKER_NETWORK
    external: true
EOF
fi
