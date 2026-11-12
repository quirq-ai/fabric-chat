#!/bin/bash
# enrol.sh <person id>
# Runs inside a company's CA container. Registers the person with the CA, then enrols them: makes a
# private key, has the CA sign a certificate for it, and leaves both in the company's wallet folder.
# That certificate is the person's identity on the network. Prints "enrolled" or "already enrolled".
set -euo pipefail

id="$1"
if ! [[ "$id" =~ ^[a-z0-9][a-z0-9._-]{0,31}$ ]]; then
  echo "A person id is lower-case letters, digits, dot, dash or underscore." >&2
  exit 2
fi

url="localhost:7054"
tls=(--tls.certfiles "$CA_CERT")
wallet="/wallet/$id"

if [ -f "$wallet/msp/signcerts/cert.pem" ]; then
  echo "already enrolled"
  exit 0
fi

# The registrar is the CA's own administrator: the only identity allowed to add people.
export FABRIC_CA_CLIENT_HOME=/tmp/registrar
if [ ! -f "$FABRIC_CA_CLIENT_HOME/msp/signcerts/cert.pem" ]; then
  fabric-ca-client enroll -u "https://registrar:$REGISTRAR_SECRET@$url" "${tls[@]}" >/tmp/enrol.log 2>&1 \
    || { tail -3 /tmp/enrol.log >&2; exit 1; }
fi

# A one-time password the person would be given to collect their certificate. Here it is used at once.
secret="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
fabric-ca-client register --id.name "$id" --id.secret "$secret" --id.type client -u "https://$url" "${tls[@]}" >/tmp/enrol.log 2>&1 \
  || { tail -3 /tmp/enrol.log >&2; exit 1; }

FABRIC_CA_CLIENT_HOME=/tmp/enrol-$id fabric-ca-client enroll -u "https://$id:$secret@$url" -M "$wallet/msp" "${tls[@]}" >/tmp/enrol.log 2>&1 \
  || { tail -3 /tmp/enrol.log >&2; exit 1; }
rm -rf "/tmp/enrol-$id"

# One name for the key file, whatever the CA called it.
for key in "$wallet"/msp/keystore/*_sk; do
  mv "$key" "$wallet/msp/keystore/priv_sk"
  break
done
echo "enrolled"
