#!/bin/bash
# Makes the test certificates, each channel's first block and the chaincode package.
# Runs once in a throwaway tools container, with .generated mounted at /work.
set -euo pipefail
cd /work
source /work/net.env

if [ ! -d crypto-config ]; then
  cryptogen generate --config=crypto-config.yaml --output=crypto-config >/dev/null
  echo "certificates made for ${#ORGS[@]} companies"
fi

# Fabric 2.5 needs no system channel. Each channel starts from its own first block, which holds the
# whole channel configuration: who the members are, who orders, and the rules for changing it.
mkdir -p channel-artifacts
export FABRIC_CFG_PATH=/work
for channel in "${CHANNELS[@]}"; do
  if [ ! -f "channel-artifacts/$channel.block" ]; then
    configtxgen -profile "$channel" -channelID "$channel" -outputBlock "channel-artifacts/$channel.block" 2>>channel-artifacts/configtxgen.log \
      || { tail -5 channel-artifacts/configtxgen.log >&2; exit 1; }
  fi
done
echo "first blocks made for: ${CHANNELS[*]}"

# The chaincode runs as a service, so the package the peers install holds no code: only where to
# reach the chaincode. {{.peername}} is filled in by each peer with its own company's address.
if [ ! -f chaincode/package.id ]; then
  label="${CC_NAME}_${CC_VERSION}"
  build="$(mktemp -d)"
  printf '{"address":"%s.{{.peername}}:9999","dial_timeout":"10s","tls_required":false}\n' "$CC_NAME" >"$build/connection.json"
  printf '{"type":"ccaas","label":"%s"}\n' "$label" >"$build/metadata.json"
  # Fixed dates and owners, so the same inputs always give the same package ID.
  pack() { tar --sort=name --mtime='2026-01-01 00:00:00Z' --owner=0 --group=0 --numeric-owner -cf - -C "$build" "$@" | gzip -n; }
  pack connection.json >"$build/code.tar.gz"
  pack metadata.json code.tar.gz >"chaincode/$label.tar.gz"
  rm -rf "$build"
  export FABRIC_CFG_PATH=/etc/hyperledger/fabric
  id="$(peer lifecycle chaincode calculatepackageid "chaincode/$label.tar.gz")"
  echo "$id" >chaincode/package.id
  echo "CHAINCODE_ID=$id" >chaincode/chaincode.env
  echo "chaincode package made: $id"
fi
