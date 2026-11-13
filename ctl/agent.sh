#!/bin/bash
# ctl agent: the one part of a company's server that stays up holding the node administrator's key.
#
# The chat app is what people's browsers reach, so it is kept away from that key. When an
# administrator shares a workspace with another company, the app leaves a request in a folder the
# two share, and the agent answers it. The agent knows five requests and refuses anything else:
#
#   create      start a workspace with the companies whose cards are given, and return the invitation
#   reach       try the peer and the orderer on a card, and say whether this server can reach them
#   inspect     check an invitation and say who is in it and whether their nodes can be reached, without joining
#   accept      check an invitation and join
#   invitation  return the invitation of a workspace this company is on
#
# Between requests it brings each new workspace's rules into force as soon as that can be done.
source "$(dirname "$0")/lib.sh"
read_company
use_admin
source "$(dirname "$0")/workspaces.sh"
trap 'exit 0' TERM INT

mkdir -p "$DESK/requests" "$DESK/results"
# A request left over from before a restart has nobody waiting for its answer.
rm -f "$DESK"/requests/* "$DESK"/results/*
chown 1000:1000 "$DESK" "$DESK/requests" "$DESK/results"
chmod 770 "$DESK" "$DESK/requests" "$DESK/results"
publish_state
echo "the node agent of $COMPANY_NAME is waiting for requests"

# run <kind> <request file> <scratch folder>: does one request and prints its answer as JSON.
run() {
  local kind="$1" file="$2" work="$3" channel
  case "$kind" in
    create)
      jq '.cards' "$file" >"$work/cards.json"
      workspace_create "$(jq -r '.name // empty | tostring' "$file")" "$work/cards.json"
      ;;
    inspect)
      jq '.invitation' "$file" >"$work/invitation.json"
      check_invitation "$work/invitation.json" "$work/check" reach
      cat "$work/check/summary.json"
      ;;
    reach)
      jq '.card' "$file" >"$work/card.json"
      reach "$work/cards" "$(lay_card "$work/card.json" "$work/cards")"
      ;;
    accept)
      jq '.invitation' "$file" >"$work/invitation.json"
      workspace_accept "$work/invitation.json"
      ;;
    invitation)
      channel="$(jq -r '.channel // empty | tostring' "$file")"
      [[ "$channel" =~ ^ws-[0-9a-f]{10}$ ]] && [ -f "$WORKSPACES/$channel/invitation.json" ] || fail "This server holds no invitation for that workspace."
      cat "$WORKSPACES/$channel/invitation.json"
      ;;
    *)
      fail "The node does not know that request."
      ;;
  esac
}

# handle <request file>: answers one request. A refusal is an answer too: it never stops the agent.
handle() {
  local file="$1" id kind work status
  id="$(jq -r '.id // empty | tostring' "$file" 2>/dev/null || true)"
  if ! [[ "$id" =~ ^[0-9a-f]{32}$ ]]; then
    rm -f "$file"
    return 0
  fi
  kind="$(jq -r '.kind // empty | tostring' "$file" 2>/dev/null || true)"
  work="$(mktemp -d)"
  # In a shell of its own, where any failed step ends the request at once.
  set +e
  (
    set -e
    run "$kind" "$file" "$work"
  ) >"$work/answer" 2>"$work/said"
  status=$?
  set -e
  if [ "$status" -eq 0 ] && jq -e . "$work/answer" >/dev/null 2>&1; then
    jq -cn --arg id "$id" --slurpfile data "$work/answer" '{id: $id, ok: true, data: $data[0]}' >"$DESK/results/$id.new"
    echo "request $kind: done"
  else
    jq -cn --arg id "$id" --arg message "$(tail -n 1 "$work/said")" '{id: $id, ok: false, message: (if $message == "" then "The node could not do that." else $message end)}' >"$DESK/results/$id.new"
    echo "request $kind: refused: $(tail -n 1 "$work/said")"
  fi
  chown 1000:1000 "$DESK/results/$id.new"
  mv "$DESK/results/$id.new" "$DESK/results/$id.json"
  rm -rf "$work" "$file"
}

tick=0
while true; do
  for request in "$DESK"/requests/*.json; do
    [ -e "$request" ] || continue
    # Called on its own line, never after "||" or inside "if": bash would then stop treating a
    # failed step inside it as a failure, and a refused card could slip through.
    handle "$request"
  done
  if [ $((tick % 4)) -eq 0 ]; then
    for dir in "$WORKSPACES"/*/; do
      [ -f "$dir/workspace.json" ] || continue
      set +e
      (
        set -e
        workspace_settle "$(basename "$dir")"
      )
      set -e
    done
  fi
  tick=$((tick + 1))
  sleep 1
done
