#!/bin/bash
# ctl setup: runs once the peer and the orderer are up. Joins both to the home workspace and
# deploys the chat's rules the Fabric 2.x way: install, approve, commit. Safe to run again:
# whatever is already in place is skipped, so a second ./chat up takes a few seconds.
source "$(dirname "$0")/lib.sh"
read_company
use_admin
log="$(mktemp)"
out=""

# 1. The orderer is handed the first block through its admin port. With one orderer it is its own
#    Raft leader at once, and the workspace can take transactions.
join_orderer() {
  out="$(osnadmin channel list --channelID "$CHANNEL" "${ORDERER_ADMIN[@]}" 2>&1 || true)"
  if grep -q '^Status: 200' <<<"$out"; then
    return 0
  fi
  out="$(osnadmin channel join --channelID "$CHANNEL" --config-block "$NODE/channel/$CHANNEL.block" "${ORDERER_ADMIN[@]}" 2>&1 || true)"
  grep -q '^Status: 201' <<<"$out"
}
retry 30 join_orderer || {
  tail -3 <<<"$out" >&2
  fail "The orderer could not join the home workspace. See: ./chat logs orderer"
}

# An orderer that has just started takes up to ten seconds to settle as the workspace's leader, and
# until then it turns every transaction away. Wait here, so that "up" means messages go through.
leads() {
  local metrics
  metrics="$(curl -s --max-time 3 "http://$ORDERER_HOST:9443/metrics" || true)"
  grep -q "^consensus_etcdraft_is_leader{channel=\"$CHANNEL\"} 1" <<<"$metrics"
}
retry 30 leads || fail "The orderer is running, but after a minute it is still not ready to order. See: ./chat logs orderer"

# 2. The peer starts its copy of the ledger from the same block, then fetches every later block
#    from the orderer and checks it before storing it.
join_peer() {
  out="$(peer channel list 2>&1 || true)"
  if grep -qx "$CHANNEL" <<<"$out"; then
    return 0
  fi
  out="$(peer channel join -b "$NODE/channel/$CHANNEL.block" 2>&1 || true)"
  grep -q 'Successfully submitted proposal to join channel' <<<"$out"
}
retry 30 join_peer || {
  tail -3 <<<"$out" >&2
  fail "The peer could not join the home workspace. See: ./chat logs peer"
}
echo "home workspace: orderer and peer joined (channel \"$CHANNEL\")"

# 3. Install. The package is only a pointer to the chaincode container, so this takes a moment.
label="${CC_NAME}_${CC_VERSION}"
package_id="$(cat "$NODE/chaincode/package.id")"
installed="$(peer lifecycle chaincode queryinstalled 2>/dev/null || true)"
if ! grep -q "Package ID: $package_id," <<<"$installed"; then
  if ! retry 5 peer lifecycle chaincode install "$NODE/chaincode/$label.tar.gz" >"$log" 2>&1; then
    tail -5 "$log" >&2
    fail "The chat's rules could not be installed on the peer."
  fi
fi

committed_sequence() {
  local found
  found="$(peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$CC_NAME" 2>/dev/null || true)"
  sed -n 's/.*Sequence: \([0-9]*\).*/\1/p' <<<"$found"
}

if [ "$(committed_sequence)" = "$CC_SEQUENCE" ]; then
  echo "home workspace: the chat's rules ($CC_NAME $CC_VERSION) are already in force"
else
  # 4. Approve. On a shared workspace every company does this for itself, and the rules take effect
  #    once more than half have. Here there is one company, so one approval is enough.
  definition=(-C "$CHANNEL" -n "$CC_NAME" -v "$CC_VERSION" --sequence "$CC_SEQUENCE")
  ready="$(peer lifecycle chaincode checkcommitreadiness "${definition[@]}" --output json 2>/dev/null || echo '{}')"
  if [ "$(jq -r --arg id "$COMPANY_ID" '.approvals[$id] // false' <<<"$ready")" != "true" ]; then
    if ! retry 10 peer lifecycle chaincode approveformyorg "${ORDERER[@]}" "${definition[@]}" --package-id "$package_id" >"$log" 2>&1; then
      tail -5 "$log" >&2
      fail "The chat's rules could not be approved."
    fi
  fi

  # 5. Commit: from this block on, the peer runs these rules for every transaction in the workspace.
  if ! retry 5 peer lifecycle chaincode commit "${ORDERER[@]}" "${definition[@]}" \
    --peerAddresses "$PEER_HOST:7051" --tlsRootCertFiles "$NODE/ca-cert.pem" >"$log" 2>&1; then
    tail -5 "$log" >&2
    fail "The chat's rules could not be committed."
  fi
  echo "home workspace: the chat's rules ($CC_NAME $CC_VERSION) are in force"
fi

# 6. Ask for the (perhaps still empty) directory once, so the peer connects to its chaincode
#    container now rather than on the first message.
if ! retry 20 peer chaincode query -C "$CHANNEL" -n "$CC_NAME" -c '{"Args":["Directory"]}' >/dev/null 2>"$log"; then
  tail -3 "$log" >&2
  fail "The peer cannot reach the chaincode container. See: ./chat logs chaincode"
fi
echo "the peer reaches its chaincode"
