#!/bin/bash
# ctl prepare: the first step of ./chat up. Makes what must exist before any node starts: the
# company's passwords and its root certificate. Everything is made on this server and stays in its
# volumes. Safe to run again: whatever is already there is left alone.
source "$(dirname "$0")/lib.sh"
read_company
umask 077
mkdir -p "$NODE/secrets" "$APP" "$RULES"

# 1. A server belongs to one company for good. Its ID is written into every certificate and every
#    record on the ledger, and its node names into the workspace's rules, so none of them can change.
launch="$NODE/launch.json"
if [ -f "$launch" ]; then
  was() { jq -r ".$1" "$launch"; }
  changed=""
  [ "$(was id)" = "$COMPANY_ID" ] || changed="\"id\" (was $(was id))"
  [ "$(was peer)" = "$PEER_HOST" ] || changed="\"hosts.peer\" (was $(was peer))"
  [ "$(was orderer)" = "$ORDERER_HOST" ] || changed="\"hosts.orderer\" (was $(was orderer))"
  if [ -n "$changed" ]; then
    fail "company.json: $changed cannot be changed after the first ./chat up. Put it back, or start again from nothing with ./chat wipe."
  fi
else
  jq -n --arg id "$COMPANY_ID" --arg peer "$PEER_HOST" --arg orderer "$ORDERER_HOST" '{id: $id, peer: $peer, orderer: $orderer}' >"$launch"
fi

# 2. Passwords. Each is used by one program to reach another on this server, and by nothing else.
secret "$NODE/secrets/registrar" # the certificate authority's own administrator
secret "$NODE/secrets/couchdb"   # the peer's state database
if [ ! -s "$APP/wallet.key" ]; then
  # The app encrypts each person's private key with this before it writes it to disk.
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$APP/wallet.key"
fi
if [ ! -s /couchdb-config/admin.ini ]; then
  # CouchDB reads its administrator from this file, and replaces the password with its hash.
  printf '[admins]\nadmin = %s\n' "$(cat "$NODE/secrets/couchdb")" >/couchdb-config/admin.ini
fi

# 3. The root certificate: the one thing every other certificate of this company is signed under.
#    Another company trusts this company's people and nodes by trusting this certificate.
if [ ! -f "$CA_HOME/.ready" ]; then
  work="$(mktemp -d)"
  cat >"$work/root.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
O = $COMPANY_ID
CN = ca.$COMPANY_ID
[v3]
basicConstraints = critical,CA:TRUE,pathlen:1
keyUsage = critical,digitalSignature,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/ca-key.pem" 2>/dev/null
  openssl req -x509 -new -key "$work/ca-key.pem" -sha256 -days 5475 -config "$work/root.cnf" -out "$work/ca-cert.pem"

  # Give the authority its own folder: settings, an empty register, and its administrator.
  cp "$work/ca-key.pem" "$work/ca-cert.pem" "$CA_HOME/"
  if ! fabric-ca-server init --home "$CA_HOME" -b "registrar:$(cat "$NODE/secrets/registrar")" \
    --ca.certfile ca-cert.pem --ca.keyfile ca-key.pem --ca.name "ca.$COMPANY_ID" >"$work/init.log" 2>&1; then
    tail -5 "$work/init.log" >&2
    fail "The certificate authority could not be set up."
  fi
  # Fabric CA signs certificates for one year unless told otherwise. A node whose certificate runs
  # out stops working, and renewing is not built yet, so they are signed for ten years.
  sed -i 's/expiry: 8760h/expiry: 87600h/' "$CA_HOME/fabric-ca-server-config.yaml"
  grep -q 'expiry: 87600h' "$CA_HOME/fabric-ca-server-config.yaml" || fail "The certificate authority's settings could not be changed."
  rm -rf "$work"
  touch "$CA_HOME/.ready"
  echo "root certificate made for $COMPANY_ID (O=$COMPANY_ID, CN=ca.$COMPANY_ID)"
fi
cp "$CA_HOME/ca-cert.pem" "$NODE/ca-cert.pem"
cp "$CA_HOME/ca-cert.pem" "$APP/ca-cert.pem"
chmod 644 "$NODE/ca-cert.pem" "$APP/ca-cert.pem"

echo "$COMPANY_NAME ($COMPANY_ID) is ready for its nodes"
