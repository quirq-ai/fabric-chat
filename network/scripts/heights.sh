#!/bin/bash
# Prints one line of JSON per channel and company: how many blocks that company's peer holds and the
# hash of its newest block. Equal hashes mean the companies hold the same ledger.
source /scripts/lib.sh

for channel in "${CHANNELS[@]}"; do
  for code in ${CHANNEL_ORGS[$channel]}; do
    use_org "$code"
    info="$(peer channel getinfo -c "$channel" 2>/dev/null | sed -n 's/^Blockchain info: //p')"
    if [ -z "$info" ]; then
      jq -cn --arg channel "$channel" --arg org "$code" '{channel: $channel, org: $org, height: null, hash: null}'
    else
      jq -cn --arg channel "$channel" --arg org "$code" --argjson info "$info" \
        '{channel: $channel, org: $org, height: $info.height, hash: $info.currentBlockHash}'
    fi
  done
done
