#!/bin/bash
# Joins each company's orderer and peer to the channels it belongs to.
# Safe to run again: anything already done is skipped.
source /scripts/lib.sh
cd /work

# join_orderer <company> <channel>: hand the channel's first block to that company's orderer.
join_orderer() {
  local code="$1" channel="$2" tls out
  tls="$(orderer_tls "$code")"
  local admin=(-o "${ORG_ORDERER[$code]}:7053" --ca-file "$tls/ca.crt" --client-cert "$tls/server.crt" --client-key "$tls/server.key")
  out="$(osnadmin channel list --channelID "$channel" "${admin[@]}" 2>&1 || true)"
  if grep -q '^Status: 200' <<<"$out"; then
    return 0
  fi
  out="$(osnadmin channel join --channelID "$channel" --config-block "channel-artifacts/$channel.block" "${admin[@]}" 2>&1 || true)"
  grep -q '^Status: 201' <<<"$out"
}

# join_peer <company> <channel>: the peer starts its copy of the ledger from the same first block.
join_peer() {
  local code="$1" channel="$2" out
  use_org "$code"
  out="$(peer channel list 2>/dev/null || true)"
  if grep -qx "$channel" <<<"$out"; then
    return 0
  fi
  peer channel join -b "channel-artifacts/$channel.block" >/dev/null 2>&1
}

for channel in "${CHANNELS[@]}"; do
  # 1. Orderers. Once enough of them hold the first block they elect a Raft leader, and the channel
  #    can take transactions.
  for code in ${CHANNEL_ORGS[$channel]}; do
    retry 15 join_orderer "$code" "$channel" || { echo "$code's orderer could not join $channel" >&2; exit 1; }
  done
  echo "channel $channel: orderers joined (${CHANNEL_ORGS[$channel]})"

  # 2. Peers. Each then fetches every later block from an orderer and checks it before storing it.
  for code in ${CHANNEL_ORGS[$channel]}; do
    retry 15 join_peer "$code" "$channel" || { echo "$code's peer could not join $channel" >&2; exit 1; }
  done
  echo "channel $channel: peers joined (${CHANNEL_ORGS[$channel]})"
done
