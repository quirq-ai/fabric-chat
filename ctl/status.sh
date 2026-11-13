#!/bin/bash
# ctl status: asks this company's own peer how much of each workspace's ledger it holds.
source "$(dirname "$0")/lib.sh"
read_company
use_admin

echo "$COMPANY_NAME ($COMPANY_ID)"
# The peer prints a heading, then one channel name on each line.
channels="$(peer channel list 2>/dev/null | grep -E '^[a-z][a-z0-9.-]*$' || true)"
if [ -z "$channels" ]; then
  echo "The peer did not answer, or has not joined a workspace yet."
  exit 1
fi
printf '%-14s %8s  %s\n' "Workspace" "Blocks" "Newest block hash"
for channel in $channels; do
  info="$(peer channel getinfo -c "$channel" 2>/dev/null | sed -n 's/^Blockchain info: //p')"
  if [ -z "$info" ]; then
    printf '%-14s %8s  %s\n' "$channel" "-" "not reachable"
  else
    printf '%-14s %8s  %s\n' "$channel" "$(jq -r .height <<<"$info")" "$(jq -r .currentBlockHash <<<"$info")"
  fi
done
rules="$(peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$CC_NAME" 2>/dev/null | sed -n 's/^Version: \([^,]*\), Sequence: \([0-9]*\).*/version \1, sequence \2/p' || true)"
echo "Rules in force on \"$CHANNEL\": $CC_NAME ${rules:-not deployed}"
