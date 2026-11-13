#!/bin/bash
# ctl init: runs once the certificate authority is up. Has it issue a certificate to each node, to
# the node's administrator and to the chat app, then makes the home workspace's first block and the
# chaincode package. Safe to run again: whatever is already there is left alone.
source "$(dirname "$0")/lib.sh"
read_company
umask 077

tls=(--tls.certfiles "$NODE/ca-cert.pem")
# The certificate authority fills in the name (CN) and the role (OU) itself. This is the rest.
names=(--csr.names "O=$COMPANY_ID")
log="$(mktemp)"

retry 30 fabric-ca-client getcainfo -u "https://$CA_URL" "${tls[@]}" --home /tmp/cainfo >/dev/null 2>&1 ||
  fail "The certificate authority did not answer. See: ./chat logs ca"

# The registrar is the authority's own administrator: it may add any kind of identity.
export FABRIC_CA_CLIENT_HOME="$NODE/registrar"
if [ ! -f "$NODE/registrar/msp/signcerts/cert.pem" ]; then
  if ! fabric-ca-client enroll -u "https://registrar:$(cat "$NODE/secrets/registrar")@$CA_URL" "${tls[@]}" "${names[@]}" >"$log" 2>&1; then
    tail -3 "$log" >&2
    fail "The certificate authority refused its own administrator."
  fi
fi

# One name for each file, whatever the authority's client called it.
tidy() {
  local dir="$1" found
  for found in "$dir"/keystore/*_sk; do
    mv "$found" "$dir/keystore/priv_sk"
    break
  done
  for found in "$dir"/cacerts/*.pem; do
    [ "$found" = "$dir/cacerts/ca-cert.pem" ] || mv "$found" "$dir/cacerts/ca-cert.pem"
    break
  done
  rm -rf "$dir/user" "$dir/IssuerPublicKey" "$dir/IssuerRevocationPublicKey"
  node_ous "$dir"
}

# issue <name> <role> <folder> [attributes]: register an identity and collect its certificate.
# The private key is made here, in the folder, and is never sent anywhere.
issue() {
  local name="$1" role="$2" dir="$3" attrs="${4:-}" out pw
  [ -f "$dir/signcerts/cert.pem" ] && return 0
  secret "$NODE/secrets/id-$name"
  pw="$(cat "$NODE/secrets/id-$name")"
  local args=(--id.name "$name" --id.secret "$pw" --id.type "$role")
  [ -n "$attrs" ] && args+=(--id.attrs "$attrs")
  if ! out="$(fabric-ca-client register "${args[@]}" -u "https://$CA_URL" "${tls[@]}" 2>&1)"; then
    # Registered on an earlier run that stopped before the certificate was collected.
    grep -q "already registered" <<<"$out" || {
      tail -3 <<<"$out" >&2
      fail "The certificate authority would not register $name."
    }
  fi
  rm -rf "$dir"
  if ! FABRIC_CA_CLIENT_HOME="/tmp/enrol-$name" fabric-ca-client enroll -u "https://$name:$pw@$CA_URL" -M "$dir" "${tls[@]}" "${names[@]}" >"$log" 2>&1; then
    tail -3 "$log" >&2
    fail "The certificate authority would not sign a certificate for $name."
  fi
  tidy "$dir"
  echo "certificate issued: $name ($role)"
}

# issue_tls <name> <host names> <folder>: a second certificate for the same identity, used to
# encrypt and prove its network connections. The host names are the ones it will be reached by.
issue_tls() {
  local name="$1" hosts="$2" dir="$3" work
  [ -f "$dir/server.crt" ] && return 0
  work="$(mktemp -d)"
  if ! FABRIC_CA_CLIENT_HOME="$work" fabric-ca-client enroll -u "https://$name:$(cat "$NODE/secrets/id-$name")@$CA_URL" \
    --enrollment.profile tls --csr.hosts "$hosts" -M "$work/msp" "${tls[@]}" "${names[@]}" >"$log" 2>&1; then
    tail -3 "$log" >&2
    fail "The certificate authority would not sign a connection certificate for $name."
  fi
  mkdir -p "$dir"
  cp "$work"/msp/keystore/*_sk "$dir/server.key"
  cp "$work"/msp/tlscacerts/*.pem "$dir/ca.crt"
  cp "$work"/msp/signcerts/*.pem "$dir/server.crt"
  rm -rf "$work"
}

# 1. The nodes, and the administrator who joins them to workspaces and deploys the rules.
issue peer peer "$NODE/peer/msp"
issue_tls peer "peer,$PEER_HOST,localhost" "$NODE/peer/tls"
issue orderer orderer "$NODE/orderer/msp"
issue_tls orderer "orderer,$ORDERER_HOST,localhost" "$NODE/orderer/tls"
issue node-admin admin "$NODE/admin/msp"
issue_tls node-admin "localhost" "$NODE/admin/tls"

# 2. The chat app's two identities. Neither is a person and neither ever posts.
#    chat-service reads blocks as they arrive. people-registrar may add people and nothing else:
#    its role is not one Fabric accepts on a channel, so its key is useless on the ledger.
issue chat-service client "$NODE/service/msp"
issue people-registrar registrar "$NODE/people-registrar/msp" "hf.Registrar.Roles=client,hf.Revoker=true"
mkdir -p "$APP/service" "$APP/registrar/msp/signcerts" "$APP/registrar/msp/keystore" "$APP/registrar/msp/cacerts"
cp "$NODE/service/msp/signcerts/cert.pem" "$APP/service/cert.pem"
cp "$NODE/service/msp/keystore/priv_sk" "$APP/service/key.pem"
cp "$NODE/people-registrar/msp/signcerts/cert.pem" "$APP/registrar/msp/signcerts/cert.pem"
cp "$NODE/people-registrar/msp/keystore/priv_sk" "$APP/registrar/msp/keystore/priv_sk"
cp "$NODE/ca-cert.pem" "$APP/registrar/msp/cacerts/ca-cert.pem"

# 3. The company as other nodes see it: its root certificate and how to read roles. No keys.
mkdir -p "$NODE/msp/cacerts" "$NODE/msp/tlscacerts"
cp "$NODE/ca-cert.pem" "$NODE/msp/cacerts/ca-cert.pem"
cp "$NODE/ca-cert.pem" "$NODE/msp/tlscacerts/ca-cert.pem"
node_ous "$NODE/msp"

# 4. The home workspace's first block. Fabric 2.5 has no network to join, only channels, and a
#    channel starts from one block holding all of its rules: who is on it, who orders it, and how
#    that can change. Here the answer to all three is this company alone.
mkdir -p "$NODE/channel"
if [ ! -f "$NODE/channel/$CHANNEL.block" ]; then
  id="$COMPANY_ID"
  cat >"$NODE/channel/configtx.yaml" <<EOF
# Written by ctl init. Read by configtxgen to make the home workspace's first block.
Organizations:
  - &Members
    Name: $id
    ID: $id
    MSPDir: $NODE/msp
    Policies:
      Readers: { Type: Signature, Rule: "OR('$id.admin', '$id.peer', '$id.client')" }
      Writers: { Type: Signature, Rule: "OR('$id.admin', '$id.client')" }
      Admins: { Type: Signature, Rule: "OR('$id.admin')" }
      Endorsement: { Type: Signature, Rule: "OR('$id.peer')" }
    AnchorPeers:
      - Host: $PEER_HOST
        Port: 7051
  # The same company, in its part as an orderer. Only a certificate with the orderer role can sign a block.
  - &Orderers
    Name: $id
    ID: $id
    MSPDir: $NODE/msp
    Policies:
      Readers: { Type: Signature, Rule: "OR('$id.member')" }
      Writers: { Type: Signature, Rule: "OR('$id.orderer')" }
      Admins: { Type: Signature, Rule: "OR('$id.admin')" }
    OrdererEndpoints:
      - $ORDERER_HOST:7050
Profiles:
  Home:
    Policies:
      Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }
      Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }
      Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }
    Capabilities: { V2_0: true }
    Orderer:
      OrdererType: etcdraft
      BatchTimeout: 1s
      BatchSize:
        MaxMessageCount: 50
        AbsoluteMaxBytes: 10 MB
        PreferredMaxBytes: 2 MB
      EtcdRaft:
        Consenters:
          # Orderers reach each other on their own port, which insists on a certificate from both ends.
          - Host: $ORDERER_HOST
            Port: 7055
            ClientTLSCert: $NODE/orderer/tls/server.crt
            ServerTLSCert: $NODE/orderer/tls/server.crt
      Organizations:
        - *Orderers
      Policies:
        Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }
        Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }
        Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }
        BlockValidation: { Type: ImplicitMeta, Rule: "ANY Writers" }
      Capabilities: { V2_0: true }
    Application:
      Organizations:
        - *Members
      Policies:
        Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }
        Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }
        Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }
        LifecycleEndorsement: { Type: ImplicitMeta, Rule: "MAJORITY Endorsement" }
        Endorsement: { Type: ImplicitMeta, Rule: "MAJORITY Endorsement" }
      # V2_5 turns on purging of private data, which "delete" uses in members-only conversations.
      Capabilities: { V2_5: true }
EOF
  if ! FABRIC_CFG_PATH="$NODE/channel" configtxgen -profile Home -channelID "$CHANNEL" -outputBlock "$NODE/channel/$CHANNEL.block.new" >"$log" 2>&1; then
    tail -5 "$log" >&2
    fail "The home workspace's first block could not be made."
  fi
  mv "$NODE/channel/$CHANNEL.block.new" "$NODE/channel/$CHANNEL.block"
  echo "first block made for the home workspace (channel \"$CHANNEL\")"
fi

# 5. The chaincode package. The chat's rules run as a service in their own container, so the
#    package the peer installs holds no code: only where to reach that container.
mkdir -p "$NODE/chaincode"
label="${CC_NAME}_${CC_VERSION}"
if [ ! -f "$NODE/chaincode/package.id" ]; then
  build="$(mktemp -d)"
  printf '{"address":"chaincode:9999","dial_timeout":"10s","tls_required":false}\n' >"$build/connection.json"
  printf '{"type":"ccaas","label":"%s"}\n' "$label" >"$build/metadata.json"
  # Fixed dates and owners, so the same inputs always give the same package ID.
  pack() { tar --sort=name --mtime='2026-01-01 00:00:00Z' --owner=0 --group=0 --numeric-owner -cf - -C "$build" "$@" | gzip -n; }
  pack connection.json >"$build/code.tar.gz"
  pack metadata.json code.tar.gz >"$NODE/chaincode/$label.tar.gz"
  rm -rf "$build"
  FABRIC_CFG_PATH=/etc/hyperledger/fabric peer lifecycle chaincode calculatepackageid "$NODE/chaincode/$label.tar.gz" >"$NODE/chaincode/package.id"
  echo "chaincode package made: $(cat "$NODE/chaincode/package.id")"
fi
cp "$NODE/chaincode/package.id" "$RULES/package.id"
chmod 755 "$RULES"
chmod 644 "$RULES/package.id"

# 6. The facts the chat app starts from. The name and colour may change between runs; the rest may not.
jq -n \
  --arg id "$COMPANY_ID" --arg name "$COMPANY_NAME" --arg color "$COMPANY_COLOR" \
  --arg chat "$CHAT_HOST" --arg peer "$PEER_HOST" --arg orderer "$ORDERER_HOST" \
  --arg handle "$ADMIN_HANDLE" --arg admin "$ADMIN_NAME" --arg title "$ADMIN_TITLE" \
  --arg address "$LISTEN_ADDRESS" --arg port "$LISTEN_PORT" --arg https "$HTTPS" --arg origin "$CHAT_ORIGIN" --arg release "${RELEASE:-dev}" --arg fabric "$FABRIC_VERSION" \
  --arg ca "https://$CA_URL" --arg cc "$CC_NAME" --arg version "$CC_VERSION" --arg sequence "$CC_SEQUENCE" \
  '{
    company: {id: $id, name: $name, color: $color},
    hosts: {chat: $chat, peer: $peer, orderer: $orderer},
    admin: {handle: $handle, name: $admin, title: $title},
    listen: {address: $address, port: ($port | tonumber)},
    https: ($https != "off"),
    origin: $origin,
    release: $release,
    fabric: $fabric,
    ca: {url: $ca, name: ("ca." + $id)},
    consensus: {type: "etcdraft", batchTimeout: "1s", maxMessageCount: 50},
    chaincode: {name: $cc, version: $version, sequence: ($sequence | tonumber)}
  }' >"$APP/node.json.new"
mv "$APP/node.json.new" "$APP/node.json"

# 7. The company's card: its public face, for other companies. Nothing in it is secret.
source "$(dirname "$0")/workspaces.sh"
own_card >"$NODE/card.json"
cp "$NODE/card.json" "$APP/card.json"
keep_card "$NODE/card.json" >/dev/null

# 8. The list of workspaces this company is on. It starts with one: its own.
mkdir -p "$WORKSPACES/$CHANNEL"
jq -n --arg channel "$CHANNEL" --arg name "$COMPANY_NAME" --arg id "$COMPANY_ID" \
  '{channel: $channel, name: $name, members: [$id], createdBy: $id, createdAt: "", home: true}' >"$WORKSPACES/$CHANNEL/workspace.json"
echo '{"status":"ready","approvals":{}}' >"$WORKSPACES/$CHANNEL/status.json"
publish_state

# The app runs as an ordinary user (1000), and this folder is for it alone.
chown -R 1000:1000 "$APP"
echo "$COMPANY_NAME has its certificates"
