#!/bin/bash
# start.sh: runs one company's whole Fabric Chat node inside this one container.
#
# It does what ./chat up does with Docker Compose, in the same order, with the same admin scripts:
#
#   prepare -> ca, couchdb -> init -> peer, orderer, chaincode -> setup -> agent, app
#
# and then stays up for as long as every part does. If one part stops, the container stops, so
# that the host starts it again whole.
#
# Everything that must outlive the container (keys, certificates, the ledger, accounts) is kept
# under one folder, CHAT_STORE (default /app/data). Put a disk there, or it is lost at each restart.
#
# Settings, all optional:
#   CHAT_STORE           where everything is kept (default /app/data)
#   PORT                 the port the chat answers on (default 3000)
#   COMPANY_FILE         the company's settings (default /company/company.json)
#   FABRIC_LOGGING_SPEC  how much the peer and the orderer say (default WARNING)
set -uo pipefail

STORE="${CHAT_STORE:-/app/data}"
export PORT="${PORT:-3000}"
export COMPANY_FILE="${COMPANY_FILE:-/company/company.json}"
LOGGING="${FABRIC_LOGGING_SPEC:-WARNING}"
unset FABRIC_LOGGING_SPEC
CTL=/opt/ctl/ctl

mkdir -p /run/solo
export SOLO_STEP=/run/solo/step

declare -A PIDS=()
STOPPING=no

say() { echo "[start] $*"; }
step() {
  echo "$*" >"$SOLO_STEP"
  say "$*"
}

stop_all() {
  STOPPING=yes
  local pid
  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # CouchDB runs under a small supervisor of its own that does not pass the signal on.
  pkill -TERM -u couchdb 2>/dev/null || true
  wait 2>/dev/null || true
}

die() {
  say "$*"
  echo "The start failed: $*" >"$SOLO_STEP"
  stop_all
  exit 1
}

trap 'say "asked to stop"; stop_all; exit 0' TERM INT

# run <name> <command...>: start a part in the background. Every line it prints carries its name.
run() {
  local name="$1"
  shift
  "$@" > >(sed -u "s/^/[$name] /") 2>&1 &
  PIDS[$name]=$!
}

# once <name> <ctl command>: run a set-up step that works for a few seconds and stops.
once() {
  local name="$1"
  if ! "$CTL" "$name" 2>&1 | sed -u "s/^/[$name] /"; then
    die "the \"$name\" step did not finish. What it said is above."
  fi
}

# alive <name>: the part is still running.
alive() { kill -0 "${PIDS[$1]}" 2>/dev/null; }

# listening <host> <port>: something answers there.
listening() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; }

# wait_for <name> <host> <port>: until the part answers, or has stopped.
wait_for() {
  local name="$1" n=0
  until listening "$2" "$3"; do
    alive "$name" || die "$name stopped while starting. What it said is above."
    n=$((n + 1))
    [ "$n" -lt 120 ] || die "$name did not answer on port $3 within two minutes."
    sleep 1
  done
}

# ---------------------------------------------------------------------------------- 0. the page
# Answer on the chat's port from the first second, so the host sees the container as up.
node /opt/solo/waiting.mjs &
WAITING=$!
step "Checking the company's settings."

[ -f "$COMPANY_FILE" ] || die "$COMPANY_FILE was not found. Build the image with the company's company.json in it."
[ "$(id -u)" = 0 ] || die "this container must start as root. Each part then runs as its own user."
field() { jq -r "($1) // empty | tostring" "$COMPANY_FILE"; }
COMPANY_ID="$(field .id)"
PEER_HOST="$(field .hosts.peer)"
ORDERER_HOST="$(field .hosts.orderer)"
[ -n "$COMPANY_ID" ] && [ -n "$PEER_HOST" ] && [ -n "$ORDERER_HOST" ] || die "company.json needs \"id\", \"hosts.peer\" and \"hosts.orderer\"."

# ------------------------------------------------------------------------------- 1. the folders
# The admin scripts and the nodes expect fixed folders, each a volume in a normal node. Here each
# is a link into the one folder that is kept.
mkdir -p "$STORE" || die "$STORE cannot be made."
touch "$STORE/.write-test" 2>/dev/null || die "$STORE cannot be written to."
rm -f "$STORE/.write-test"
chmod 755 "$STORE" 2>/dev/null || true
if ! grep -q " $STORE " /proc/mounts; then
  say "WARNING: no disk is mounted at $STORE. Everything, keys and messages included, is lost when this container is replaced."
fi

link() {
  local path="$1" kept="$STORE/$2"
  mkdir -p "$kept" "$(dirname "$path")"
  if [ -L "$path" ]; then
    return 0
  fi
  rm -rf "$path"
  ln -s "$kept" "$path"
}
link /ca ca                                # the company's root key and the register of everyone it signed
link /node node                            # the nodes' own keys and certificates
link /app-config app-config                # what the chat app may read
link /rules rules                          # the ID of the chaincode package
link /couchdb-config couchdb-config        # the state database's administrator
link /data chat-data                       # accounts, sessions and each person's encrypted key
link /var/hyperledger/production ledger    # the peer's and the orderer's blocks
mkdir -p "$STORE/couchdb" /desk /run/chat
chown couchdb:couchdb "$STORE/couchdb"
chown chat:chat "$STORE/chat-data" /run/chat
chmod 700 /run/chat

# Every part reaches the others by name. In one container they are all this machine.
names="ca couchdb chaincode peer orderer $PEER_HOST $ORDERER_HOST"
if ! grep -q "^127.0.0.1 $names\$" /etc/hosts; then
  echo "127.0.0.1 $names" >>/etc/hosts || die "/etc/hosts cannot be written, so the parts cannot find each other."
fi

# ------------------------------------------------------------------------------------ 2. prepare
step "Making the company's passwords and root certificate."
once prepare

# ------------------------------------------------------------------------------ 3. ca, couchdb
step "Starting the certificate authority and the state database."
cd /ca
run ca env FABRIC_CA_HOME=/ca FABRIC_CA_SERVER_OPERATIONS_LISTENADDRESS=127.0.0.1:9445 fabric-ca-server start \
  --ca.certfile ca-cert.pem --ca.keyfile ca-key.pem --ca.name "ca.$COMPANY_ID" \
  --tls.enabled --csr.hosts ca,localhost --port 7054
cd /
# In a normal node the authority, the peer and the orderer each report on themselves on port 9443
# of their own container. Here they share one: the orderer keeps 9443, which the set-up step
# reads, the peer's report moves to 9444 and the authority's to 9445.

# CouchDB reads its administrator from a file and replaces the password with its hash, so it gets
# a copy. It answers inside the container only.
cp /couchdb-config/admin.ini /opt/couchdb/etc/local.d/10-admin.ini
cat >/opt/couchdb/etc/local.d/20-solo.ini <<EOF
[couchdb]
database_dir = $STORE/couchdb
view_index_dir = $STORE/couchdb
[chttpd]
bind_address = 127.0.0.1
[log]
level = warning
EOF
chown couchdb:couchdb /opt/couchdb/etc/local.d/*.ini
chmod 600 /opt/couchdb/etc/local.d/10-admin.ini
run couchdb setpriv --reuid couchdb --regid couchdb --clear-groups env HOME=/opt/couchdb /opt/couchdb/bin/couchdb

wait_for ca 127.0.0.1 7054
wait_for couchdb 127.0.0.1 5984

# --------------------------------------------------------------------------------------- 4. init
step "Issuing each node its certificates."
once init
# The app runs as an ordinary user, and this folder is for it alone.
chown -R chat:chat "$STORE/app-config"

# ---------------------------------------------------------------- 5. peer, orderer, chaincode
step "Starting the peer, the orderer and the chat's rules."
run peer env \
  FABRIC_LOGGING_SPEC="$LOGGING" \
  CORE_PEER_ID="$PEER_HOST" \
  CORE_PEER_ADDRESS="$PEER_HOST:7051" \
  CORE_PEER_LISTENADDRESS=0.0.0.0:7051 \
  CORE_PEER_GOSSIP_BOOTSTRAP="$PEER_HOST:7051" \
  CORE_PEER_GOSSIP_EXTERNALENDPOINT="$PEER_HOST:7051" \
  CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD=3s \
  CORE_PEER_LOCALMSPID="$COMPANY_ID" \
  CORE_PEER_MSPCONFIGPATH=/node/peer/msp \
  CORE_PEER_TLS_ENABLED=true \
  CORE_PEER_TLS_CERT_FILE=/node/peer/tls/server.crt \
  CORE_PEER_TLS_KEY_FILE=/node/peer/tls/server.key \
  CORE_PEER_TLS_ROOTCERT_FILE=/node/peer/tls/ca.crt \
  CORE_PEER_PROFILE_ENABLED=false \
  CORE_PEER_GATEWAY_ENABLED=true \
  CORE_CHAINCODE_EXECUTETIMEOUT=120s \
  CORE_LEDGER_STATE_STATEDATABASE=CouchDB \
  CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS=couchdb:5984 \
  CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=admin \
  CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD="$(cat /node/secrets/couchdb)" \
  CORE_LEDGER_HISTORY_ENABLEHISTORYDATABASE=true \
  CORE_OPERATIONS_LISTENADDRESS=127.0.0.1:9444 \
  peer node start

run orderer env \
  FABRIC_LOGGING_SPEC="$LOGGING" \
  ORDERER_GENERAL_LISTENADDRESS=0.0.0.0 \
  ORDERER_GENERAL_LISTENPORT=7050 \
  ORDERER_GENERAL_LOCALMSPID="$COMPANY_ID" \
  ORDERER_GENERAL_LOCALMSPDIR=/node/orderer/msp \
  ORDERER_GENERAL_TLS_ENABLED=true \
  ORDERER_GENERAL_TLS_PRIVATEKEY=/node/orderer/tls/server.key \
  ORDERER_GENERAL_TLS_CERTIFICATE=/node/orderer/tls/server.crt \
  ORDERER_GENERAL_TLS_ROOTCAS=[/node/orderer/tls/ca.crt] \
  ORDERER_GENERAL_CLUSTER_LISTENADDRESS=0.0.0.0 \
  ORDERER_GENERAL_CLUSTER_LISTENPORT=7055 \
  ORDERER_GENERAL_CLUSTER_SERVERCERTIFICATE=/node/orderer/tls/server.crt \
  ORDERER_GENERAL_CLUSTER_SERVERPRIVATEKEY=/node/orderer/tls/server.key \
  ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=/node/orderer/tls/server.crt \
  ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=/node/orderer/tls/server.key \
  ORDERER_GENERAL_CLUSTER_ROOTCAS=[/node/orderer/tls/ca.crt] \
  ORDERER_GENERAL_BOOTSTRAPMETHOD=none \
  ORDERER_CHANNELPARTICIPATION_ENABLED=true \
  ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:7053 \
  ORDERER_ADMIN_TLS_ENABLED=true \
  ORDERER_ADMIN_TLS_CERTIFICATE=/node/orderer/tls/server.crt \
  ORDERER_ADMIN_TLS_PRIVATEKEY=/node/orderer/tls/server.key \
  ORDERER_ADMIN_TLS_ROOTCAS=[/node/orderer/tls/ca.crt] \
  ORDERER_ADMIN_TLS_CLIENTROOTCAS=[/node/orderer/tls/ca.crt] \
  ORDERER_ADMIN_TLS_CLIENTAUTHREQUIRED=true \
  ORDERER_OPERATIONS_LISTENADDRESS=0.0.0.0:9443 \
  ORDERER_METRICS_PROVIDER=prometheus \
  orderer

run chaincode setpriv --reuid chaincode --regid chaincode --clear-groups env \
  CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 \
  CHAINCODE_ID_FILE=/rules/package.id \
  chat-chaincode

wait_for peer 127.0.0.1 7051
wait_for orderer 127.0.0.1 7050
wait_for chaincode 127.0.0.1 9999

# -------------------------------------------------------------------------------------- 6. setup
step "Joining the home workspace and putting the chat's rules in force."
once setup

# --------------------------------------------------------------------------------- 7. agent, app
step "Starting the chat."
run agent "$CTL" agent
n=0
until [ -d /desk/requests ]; do
  alive agent || die "the node agent stopped while starting. What it said is above."
  n=$((n + 1))
  [ "$n" -lt 60 ] || die "the node agent did not get ready within a minute."
  sleep 1
done

# The page that said "starting" gives the port to the chat app.
kill "$WAITING" 2>/dev/null || true
wait "$WAITING" 2>/dev/null || true
cd /opt/chat
run app setpriv --reuid chat --regid chat --clear-groups env \
  HOME=/home/chat \
  CHAT_NODE=/app-config \
  CHAT_DATA=/data \
  CHAT_DESK=/desk \
  CHAT_TMP=/run/chat \
  node build/server.mjs
wait_for app 127.0.0.1 "$PORT"

# The first administrator's one-time link. Nobody can run a command inside this container on a
# host like Launchpad, so the link is printed here, in the container's log. While the first
# administrator has not chosen a password, every start prints a fresh one: the log may be gone by then.
#
# A company folder may also hold a file `first-password`. Then the first administrator is given
# that password here, through the same link, so that nobody has to read the log to get in. It is a
# starting password: the administrator changes it once signed in. It is used only while the first
# administrator has not chosen a password, so it never replaces one.
FIRST_PASSWORD=/company/first-password
if [ -s "$FIRST_PASSWORD" ] && node build/operator.mjs welcome 2>&1 | grep -q -E "invite=|has not opened their link yet"; then
  token="$(node build/operator.mjs admin-link 2>&1 | grep -o 'invite=[A-Za-z0-9_-]*' | head -n 1 | cut -d= -f2)"
  chat_host="$(jq -r '.hosts.chat' /company/company.json)"
  body="$(jq -Rs '{password: (. | rtrimstr("\n") | rtrimstr("\r"))}' "$FIRST_PASSWORD")"
  if [ -n "$token" ] && curl -fsS -o /dev/null -m 60 -X POST -H "Host: $chat_host" -H "Content-Type: application/json" \
      -d "$body" "http://127.0.0.1:$PORT/api/invites/$token"; then
    say "the first administrator has been given the starting password from the company folder."
  else
    say "the starting password could not be set. The link below still works."
  fi
fi

welcome="$(node build/operator.mjs welcome 2>&1)" || die "the chat app did not finish starting: $welcome"
if grep -q "has not opened their link yet" <<<"$welcome"; then
  welcome="$(sed '/has not opened their link yet/,$d' <<<"$welcome")
$(node build/operator.mjs admin-link 2>&1)"
fi
echo
echo "=============================================================================="
# There is no ./chat command here. What replaces it is said in its place.
sed 's|If it is lost, make another with: ./chat admin-link|If it is lost, restart the container: while no password has been chosen, each start prints a new one.|' <<<"$welcome"
echo "=============================================================================="
echo
cd /

# ------------------------------------------------------------------------------------- 8. stay up
# Wait for any part to stop. None of them should.
wait -n "${PIDS[@]}"
code=$?
[ "$STOPPING" = no ] || exit 0
for name in "${!PIDS[@]}"; do
  alive "$name" || say "$name has stopped (exit $code)."
done
say "stopping the rest, so that the host starts the node again whole."
stop_all
exit 1
