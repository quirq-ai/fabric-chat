#!/bin/bash
# Deploys the chaincode the Fabric 2.x way: every company installs the package on its own peer and
# approves the definition for itself. Once more than half have approved, one of them commits it.
# Safe to run again: anything already in place is skipped.
source /scripts/lib.sh
cd /work

label="${CC_NAME}_${CC_VERSION}"
package="chaincode/$label.tar.gz"
package_id="$(cat chaincode/package.id)"

# 1. Install. The package is only a pointer to the chaincode service, so this takes a moment.
for code in "${ORGS[@]}"; do
  use_org "$code"
  installed="$(peer lifecycle chaincode queryinstalled 2>/dev/null || true)"
  if grep -q "Package ID: $package_id," <<<"$installed"; then
    continue
  fi
  if ! peer lifecycle chaincode install "$package" >/tmp/install.log 2>&1; then
    echo "install failed on $code's peer:" >&2
    tail -5 /tmp/install.log >&2
    exit 1
  fi
done
echo "chaincode package installed on ${#ORGS[@]} peers"

committed_sequence() {
  local out
  out="$(peer lifecycle chaincode querycommitted -C "$1" -n "$CC_NAME" 2>/dev/null || true)"
  sed -n 's/.*Sequence: \([0-9]*\).*/\1/p' <<<"$out"
}

for channel in "${CHANNELS[@]}"; do
  members=(${CHANNEL_ORGS[$channel]})
  use_org "${members[0]}"
  if [ "$(committed_sequence "$channel")" = "$CC_SEQUENCE" ]; then
    echo "channel $channel: $CC_NAME $CC_VERSION is already committed"
    continue
  fi

  # The definition every company must agree on, word for word: name, version, sequence and the
  # private data collections. A company that approved something different does not count.
  definition=(-C "$channel" -n "$CC_NAME" -v "$CC_VERSION" --sequence "$CC_SEQUENCE")
  if [ "$(jq length "collections-$channel.json")" -gt 0 ]; then
    definition+=(--collections-config "collections-$channel.json")
  fi

  # 2. Approve, one company at a time, each through its own peer and its own orderer.
  for code in "${members[@]}"; do
    use_org "$code"
    ready="$(peer lifecycle chaincode checkcommitreadiness "${definition[@]}" --output json 2>/dev/null || echo '{}')"
    if [ "$(jq -r --arg msp "${ORG_MSP[$code]}" '.approvals[$msp] // false' <<<"$ready")" = "true" ]; then
      continue
    fi
    if ! retry 5 peer lifecycle chaincode approveformyorg -o "$ORDERER_ENDPOINT" --tls --cafile "$ORDERER_CA" \
      "${definition[@]}" --package-id "$package_id" >/tmp/approve.log 2>&1; then
      echo "$code could not approve $CC_NAME on $channel:" >&2
      tail -5 /tmp/approve.log >&2
      exit 1
    fi
  done

  # 3. Commit. Every member's peer endorses the commit, and each checks its own company's approval
  #    before it signs.
  use_org "${members[0]}"
  targets=()
  for code in "${members[@]}"; do
    targets+=(--peerAddresses "${ORG_PEER[$code]}:7051" --tlsRootCertFiles "/work/crypto-config/peerOrganizations/${ORG_DOMAIN[$code]}/peers/${ORG_PEER[$code]}/tls/ca.crt")
  done
  if ! retry 5 peer lifecycle chaincode commit -o "$ORDERER_ENDPOINT" --tls --cafile "$ORDERER_CA" "${definition[@]}" "${targets[@]}" >/tmp/commit.log 2>&1; then
    echo "$CC_NAME could not be committed on $channel:" >&2
    tail -5 /tmp/commit.log >&2
    exit 1
  fi
  echo "channel $channel: $CC_NAME $CC_VERSION committed, approved by ${members[*]}"
done

# 4. Ask each peer for the (still empty) directory once, so it connects to its chaincode container
#    now rather than on the first message.
for channel in "${CHANNELS[@]}"; do
  for code in ${CHANNEL_ORGS[$channel]}; do
    use_org "$code"
    retry 15 peer chaincode query -C "$channel" -n "$CC_NAME" -c '{"Args":["Directory"]}' >/dev/null 2>/tmp/query.log \
      || { echo "$code's peer cannot reach the chaincode on $channel:" >&2; tail -3 /tmp/query.log >&2; exit 1; }
  done
done
echo "every peer reaches its chaincode"
