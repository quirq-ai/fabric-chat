#!/bin/bash
# Cards and workspaces: how this company's node comes to share a ledger with another company's.
# Sourced after lib.sh, read_company and use_admin.
#
#   A card is a company's public face: its ID and name, its root certificate, and the addresses of
#   its peer and its orderer. It holds nothing secret.
#
#   A workspace's first block says which companies are on it and how that may change. Whoever
#   starts a workspace builds that block from the members' cards, and sends it to the others with
#   the cards: an invitation. Each of them works out for itself what the block should say for those
#   cards, and joins only if the block says exactly that.

RULES_NOW="$(jq -cn --arg n "$CC_NAME" --arg v "$CC_VERSION" --arg s "$CC_SEQUENCE" '{name: $n, version: $v, sequence: ($s | tonumber)}')"
ENDPOINT_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*:[0-9]{1,5}$'

# The fingerprint two administrators can read to each other to be sure a card was not swapped on the way.
fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/^[^=]*=//; s/://g' | tr 'A-F' 'a-f'
}

# This company's own card, as JSON.
own_card() {
  jq -n --arg id "$COMPANY_ID" --arg name "$COMPANY_NAME" --arg color "$COMPANY_COLOR" \
    --arg peer "$PEER_HOST:7051" --arg orderer "$ORDERER_HOST:7050" --arg cluster "$ORDERER_HOST:7055" \
    --rawfile ca "$NODE/ca-cert.pem" --rawfile tls "$NODE/orderer/tls/server.crt" \
    '{fabricChatCard: 1, id: $id, name: $name, color: $color, peer: $peer, orderer: $orderer, cluster: $cluster, ca: $ca, ordererTls: $tls}'
}

# lay_card <card file> <folder>: checks a card, then lays it out under <folder>/<company ID> the way
# Fabric's tools read a company: its root certificate, and how to read roles from certificates.
# The two certificates are written byte for byte as the card holds them, so that every company
# that builds a first block from the same cards gets the same block. Prints the company's ID.
lay_card() {
  local file="$1" root="$2" id name field value dir
  jq -e 'type == "object" and .fabricChatCard == 1' "$file" >/dev/null 2>&1 || fail "That is not a Fabric Chat company card."
  id="$(jq -r '.id // empty | tostring' "$file")"
  [[ "$id" =~ $HOST_RE ]] && [[ "$id" == *.* ]] && [ "${#id}" -le 64 ] || fail "A card's company ID is not a domain name."
  name="$(jq -r '.name // empty | tostring' "$file")"
  [ -n "$name" ] && [ "${#name}" -le 60 ] || fail "The card of $id has no usable company name."
  for field in peer orderer cluster; do
    value="$(jq -r --arg f "$field" '.[$f] // empty | tostring' "$file")"
    [[ "$value" =~ $ENDPOINT_RE ]] || fail "The card of $id has no usable address for its $field."
  done

  dir="$root/$id"
  mkdir -p "$dir/msp/cacerts" "$dir/msp/tlscacerts"
  jq -j '.ca // empty | tostring' "$file" >"$dir/ca-cert.pem"
  jq -j '.ordererTls // empty | tostring' "$file" >"$dir/orderer-tls.pem"
  openssl x509 -in "$dir/ca-cert.pem" -noout -ext basicConstraints 2>/dev/null | grep -q 'CA:TRUE' ||
    fail "The card of $id does not hold a root certificate."
  openssl verify -CAfile "$dir/ca-cert.pem" "$dir/orderer-tls.pem" >/dev/null 2>&1 ||
    fail "The card of $id does not add up: its orderer's certificate was not signed under its root certificate."
  value="$(jq -r '.cluster' "$file")"
  openssl x509 -in "$dir/orderer-tls.pem" -noout -checkhost "${value%:*}" 2>/dev/null | grep -q 'does match' ||
    fail "The card of $id does not add up: its orderer's certificate is for another address than the card gives."
  cp "$dir/ca-cert.pem" "$dir/msp/cacerts/ca-cert.pem"
  cp "$dir/ca-cert.pem" "$dir/msp/tlscacerts/ca-cert.pem"
  node_ous "$dir/msp"
  jq -c . "$file" >"$dir/card.json"
  echo "$id"
}

# keep_card <card file>: files a card with the companies this server knows. A company's root
# certificate is who it is, so a second card with the same ID and another certificate is refused.
keep_card() {
  local file="$1" work id
  work="$(mktemp -d)"
  id="$(lay_card "$file" "$work")"
  if [ -f "$COMPANIES/$id/ca-cert.pem" ] && ! cmp -s "$COMPANIES/$id/ca-cert.pem" "$work/$id/ca-cert.pem"; then
    fail "A company called $id is already known to this server under a different root certificate. A new root certificate makes it a different company, and it cannot take over the name."
  fi
  mkdir -p "$COMPANIES"
  rm -rf "$COMPANIES/$id"
  mv "$work/$id" "$COMPANIES/$id"
  rm -rf "$work"
  echo "$id"
}

# probe <address> <root certificate>: tries one address from this server. Prints whether anything
# answered there, and whether it proved to be that company's node: it holds a certificate signed
# under the root certificate on the card, for the name on the card. Only that root counts, not the
# ones a browser would trust.
probe() {
  local address="$1" ca="$2" host="${1%:*}" said reached=false proven=false
  said="$(timeout 6 openssl s_client -connect "$address" -servername "$host" -CAfile "$ca" -no-CApath -no-CAstore -verify_hostname "$host" </dev/null 2>&1 || true)"
  if grep -q '^CONNECTED' <<<"$said"; then
    reached=true
    if grep -Eq 'Verify return code: 0 \(ok\)|Verification: OK' <<<"$said"; then
      proven=true
    fi
  fi
  jq -cn --arg address "$address" --argjson reached "$reached" --argjson proven "$proven" '{address: $address, reached: $reached, proven: $proven}'
}

# reach <cards folder> <company ID>: tries that company's peer and orderer from this server, all
# three addresses at once. Over the internet a closed port or a name that points elsewhere is the
# likeliest thing to be wrong, and without this a workspace would simply never become ready.
reach() {
  local dir="$1/$2" work field
  work="$(mktemp -d)"
  for field in peer orderer cluster; do
    probe "$(jq -r --arg f "$field" '.[$f]' "$dir/card.json")" "$dir/ca-cert.pem" >"$work/$field" &
  done
  wait
  jq -cn --slurpfile peer "$work/peer" --slurpfile orderer "$work/orderer" --slurpfile cluster "$work/cluster" \
    '{peer: $peer[0], orderer: $orderer[0], cluster: $cluster[0]}'
  rm -rf "$work"
}

# write_rules <folder> <cards folder> <company ID>...: writes configtx.yaml, from which Fabric's
# configtxgen makes a workspace's first block. The companies are given in sorted order.
write_rules() {
  local dir="$1" root="$2" id endpoint
  shift 2
  {
    echo "# Written by ctl. Read by configtxgen to make a shared workspace's first block."
    echo "Profiles:"
    echo "  Shared:"
    echo "    Policies:"
    echo '      Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }'
    echo '      Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }'
    echo '      Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }'
    echo "    Capabilities: { V2_0: true }"
    echo "    Orderer:"
    echo "      OrdererType: etcdraft"
    echo "      BatchTimeout: 1s"
    echo "      BatchSize:"
    echo "        MaxMessageCount: 50"
    echo "        AbsoluteMaxBytes: 10 MB"
    echo "        PreferredMaxBytes: 2 MB"
    echo "      EtcdRaft:"
    # Every member's orderer takes part in ordering, and no other. An orderer sees every
    # transaction it orders, so a company outside the workspace must not be one of them.
    echo "        Consenters:"
    for id in "$@"; do
      endpoint="$(jq -r '.cluster' "$root/$id/card.json")"
      echo "          - Host: ${endpoint%:*}"
      echo "            Port: ${endpoint##*:}"
      echo "            ClientTLSCert: $root/$id/orderer-tls.pem"
      echo "            ServerTLSCert: $root/$id/orderer-tls.pem"
    done
    echo "      Organizations:"
    for id in "$@"; do
      echo "        - Name: $id"
      echo "          ID: $id"
      echo "          MSPDir: $root/$id/msp"
      echo "          Policies:"
      echo "            Readers: { Type: Signature, Rule: \"OR('$id.member')\" }"
      echo "            Writers: { Type: Signature, Rule: \"OR('$id.orderer')\" }"
      echo "            Admins: { Type: Signature, Rule: \"OR('$id.admin')\" }"
      echo "          OrdererEndpoints:"
      echo "            - $(jq -r '.orderer' "$root/$id/card.json")"
    done
    echo "      Policies:"
    echo '        Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }'
    echo '        Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }'
    echo '        Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }'
    echo '        BlockValidation: { Type: ImplicitMeta, Rule: "ANY Writers" }'
    echo "      Capabilities: { V2_0: true }"
    echo "    Application:"
    echo "      Organizations:"
    for id in "$@"; do
      endpoint="$(jq -r '.peer' "$root/$id/card.json")"
      echo "        - Name: $id"
      echo "          ID: $id"
      echo "          MSPDir: $root/$id/msp"
      echo "          Policies:"
      echo "            Readers: { Type: Signature, Rule: \"OR('$id.admin', '$id.peer', '$id.client')\" }"
      echo "            Writers: { Type: Signature, Rule: \"OR('$id.admin', '$id.client')\" }"
      echo "            Admins: { Type: Signature, Rule: \"OR('$id.admin')\" }"
      echo "            Endorsement: { Type: Signature, Rule: \"OR('$id.peer')\" }"
      echo "          AnchorPeers:"
      echo "            - Host: ${endpoint%:*}"
      echo "              Port: ${endpoint##*:}"
    done
    echo "      Policies:"
    echo '        Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }'
    echo '        Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }'
    echo '        Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }'
    # More than half of the companies must approve the rules before they run, and more than half
    # must endorse a transaction before it counts.
    echo '        LifecycleEndorsement: { Type: ImplicitMeta, Rule: "MAJORITY Endorsement" }'
    echo '        Endorsement: { Type: ImplicitMeta, Rule: "MAJORITY Endorsement" }'
    echo "      Capabilities: { V2_5: true }"
  } >"$dir/configtx.yaml"
}

# make_block <folder> <channel>: the first block for the rules written in that folder.
make_block() {
  local said
  if ! said="$(FABRIC_CFG_PATH="$1" configtxgen -profile Shared -channelID "$2" -outputBlock "$1/genesis.block" 2>&1)"; then
    tail -3 <<<"$said" >&2
    fail "The workspace's first block could not be made."
  fi
}

# What a first block says, with the parts that differ from one making to the next left out: the
# companies, their certificates, who orders, and every rule for changing any of it.
config_of() {
  configtxlator proto_decode --type common.Block --input "$1" | jq -S '.data.data[0].payload.data.config'
}

block_channel() {
  configtxlator proto_decode --type common.Block --input "$1" | jq -r '.data.data[0].payload.header.channel_header.channel_id'
}

# join_nodes <channel> <first block>: hands the block to this company's orderer and peer.
join_nodes() {
  local channel="$1" block="$2" said
  said="$(osnadmin channel list --channelID "$channel" "${ORDERER_ADMIN[@]}" 2>&1 || true)"
  if ! grep -q '^Status: 200' <<<"$said"; then
    said="$(osnadmin channel join --channelID "$channel" --config-block "$block" "${ORDERER_ADMIN[@]}" 2>&1 || true)"
    grep -q '^Status: 201' <<<"$said" || {
      tail -2 <<<"$said" >&2
      fail "This company's orderer could not join the workspace."
    }
  fi
  said="$(peer channel list 2>&1 || true)"
  if ! grep -qx "$channel" <<<"$said"; then
    said="$(peer channel join -b "$block" 2>&1 || true)"
    grep -q 'Successfully submitted proposal to join channel' <<<"$said" || {
      tail -2 <<<"$said" >&2
      fail "This company's peer could not join the workspace."
    }
  fi
}

# set_status <channel> <waiting|agreeing|ready> <approvals as JSON>: notes where a workspace has got
# to, and tells the app if that is news.
set_status() {
  local file="$WORKSPACES/$1/status.json" now
  now="$(jq -cn --arg status "$2" --argjson approvals "$3" '{status: $status, approvals: $approvals}')"
  if [ "$(cat "$file" 2>/dev/null || true)" != "$now" ]; then
    echo "$now" >"$file"
    publish_state
    echo "workspace $1: $2 $3"
  fi
}

# Writes what the app needs to know about this node's workspaces and the companies in them.
publish_state() {
  local work dir id
  work="$(mktemp -d)"
  for dir in "$WORKSPACES"/*/; do
    [ -f "$dir/workspace.json" ] || continue
    [ -f "$dir/status.json" ] || echo '{"status":"waiting","approvals":{}}' >"$dir/status.json"
    jq -c --slurpfile at "$dir/status.json" '. + {status: $at[0].status, approvals: $at[0].approvals}' "$dir/workspace.json" >>"$work/workspaces"
  done
  for dir in "$COMPANIES"/*/; do
    [ -f "$dir/card.json" ] || continue
    jq -c --arg print "$(fingerprint "$dir/ca-cert.pem")" '{id, name, color: (.color // "#4b6bfb"), peer, orderer, fingerprint: $print}' "$dir/card.json" >>"$work/companies"
  done
  touch "$work/workspaces" "$work/companies"
  jq -n --slurpfile w "$work/workspaces" --slurpfile c "$work/companies" \
    '{workspaces: $w, companies: ($c | map({key: .id, value: .}) | from_entries)}' >"$APP/workspaces.json.new"
  mv "$APP/workspaces.json.new" "$APP/workspaces.json"
  chown 1000:1000 "$APP/workspaces.json"
  rm -rf "$work"
}

# workspace_create <name> <file holding the other companies' cards as a JSON list>: starts a
# workspace shared with those companies, and prints the invitation to send them.
workspace_create() {
  local name="$1" cards="$2" count i id ids work channel dir now
  [ -n "$name" ] && [ "${#name}" -le 40 ] || fail "A workspace needs a name of at most 40 characters."
  count="$(jq 'if type == "array" then length else -1 end' "$cards")"
  [ "$count" -ge 1 ] && [ "$count" -le 7 ] || fail "A shared workspace needs the card of at least one other company, and of seven at most."

  work="$(mktemp -d)"
  own_card >"$work/own.json"
  ids=("$(keep_card "$work/own.json")")
  for ((i = 0; i < count; i++)); do
    jq ".[$i]" "$cards" >"$work/card.json"
    id="$(keep_card "$work/card.json")"
    [ "$id" != "$COMPANY_ID" ] || fail "One of those cards is this company's own. Give the other companies' cards."
    [[ " ${ids[*]} " != *" $id "* ]] || fail "The card of $id was given twice."
    ids+=("$id")
  done
  # The same order at every company, so that each builds the same block from the same cards.
  mapfile -t ids < <(printf '%s\n' "${ids[@]}" | LC_ALL=C sort)

  # A channel's name is seen by every node that is on it and by no other, so it is random.
  channel="ws-$(head -c 5 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  dir="$WORKSPACES/$channel"
  mkdir -p "$dir"
  write_rules "$dir" "$COMPANIES" "${ids[@]}"
  make_block "$dir" "$channel"
  join_nodes "$channel" "$dir/genesis.block"

  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -n --arg channel "$channel" --arg name "$name" --arg by "$COMPANY_ID" --arg at "$now" --args \
    '{channel: $channel, name: $name, members: $ARGS.positional, createdBy: $by, createdAt: $at, home: false}' "${ids[@]}" >"$dir/workspace.json"
  for id in "${ids[@]}"; do cat "$COMPANIES/$id/card.json"; done >"$work/members"
  base64 -w0 "$dir/genesis.block" >"$work/block"
  jq -cn --arg channel "$channel" --arg name "$name" --arg by "$COMPANY_ID" --arg at "$now" --argjson rules "$RULES_NOW" \
    --slurpfile members "$work/members" --rawfile block "$work/block" \
    '{fabricChatInvitation: 1, channel: $channel, name: $name, createdBy: $by, createdAt: $at, rules: $rules, members: $members, block: $block}' >"$dir/invitation.json"
  rm -rf "$work"
  set_status "$channel" waiting '{}' >&2
  cat "$dir/invitation.json"
}

# check_invitation <invitation file> <empty folder> [reach]: refuses an invitation that is malformed,
# that is not for this company, or whose first block says anything but what its cards say. Leaves
# the block, the list of companies and a summary in the folder. With "reach" the summary also says
# whether this server can reach each of the other companies' nodes.
check_invitation() {
  local file="$1" work="$2" try="${3:-}" channel count i id ids=() known reached
  mkdir -p "$work/cards"
  jq -e 'type == "object" and .fabricChatInvitation == 1' "$file" >/dev/null 2>&1 || fail "That is not a Fabric Chat invitation."
  channel="$(jq -r '.channel // empty | tostring' "$file")"
  [[ "$channel" =~ ^ws-[0-9a-f]{10}$ ]] || fail "The invitation does not name its workspace properly."
  [ "$(jq -c '.rules' "$file")" = "$RULES_NOW" ] ||
    fail "The invitation is for other rules than this server runs ($CC_NAME $CC_VERSION). Every company in a workspace needs the same release."
  count="$(jq '.members | if type == "array" then length else -1 end' "$file")"
  [ "$count" -ge 2 ] && [ "$count" -le 8 ] || fail "The invitation does not list its companies properly."
  for ((i = 0; i < count; i++)); do
    jq ".members[$i]" "$file" >"$work/card.json"
    id="$(lay_card "$work/card.json" "$work/cards")"
    [[ " ${ids[*]} " != *" $id "* ]] || fail "The invitation lists $id twice."
    ids+=("$id")
  done
  [[ " ${ids[*]} " == *" $COMPANY_ID "* ]] || fail "This invitation is not for $COMPANY_NAME: $COMPANY_ID is not among its companies."

  # It must describe this company exactly as it is. The name and the colour are only labels.
  own_card >"$work/own.json"
  [ "$(jq -cS 'del(.name, .color)' "$work/own.json")" = "$(jq -cS 'del(.name, .color)' "$work/cards/$COMPANY_ID/card.json")" ] ||
    fail "The invitation describes $COMPANY_NAME wrongly: the certificate or the addresses in it are not this server's. Send the other company this company's card again."

  jq -j '.block // empty | tostring' "$file" | base64 -d >"$work/genesis.block" 2>/dev/null || fail "The invitation's first block cannot be read."
  [ "$(block_channel "$work/genesis.block" 2>/dev/null || true)" = "$channel" ] || fail "The invitation's first block is for another workspace than the invitation names."

  # Work out what the block should say for these cards, and compare.
  mapfile -t ids < <(printf '%s\n' "${ids[@]}" | LC_ALL=C sort)
  mkdir -p "$work/expected"
  write_rules "$work/expected" "$work/cards" "${ids[@]}"
  make_block "$work/expected" "$channel"
  local expected given
  expected="$(config_of "$work/expected/genesis.block" 2>/dev/null || true)"
  given="$(config_of "$work/genesis.block" 2>/dev/null || true)"
  # An unreadable block must never pass for a matching one.
  [ "${#expected}" -gt 1000 ] && [ "$expected" = "$given" ] ||
    fail "The workspace's first block does not say what the invitation's cards say, so it is not safe to join. Ask the company that sent it for a new invitation."

  printf '%s\n' "${ids[@]}" >"$work/ids"
  for id in "${ids[@]}"; do
    known=new
    if [ -f "$COMPANIES/$id/ca-cert.pem" ]; then
      known=same
      cmp -s "$COMPANIES/$id/ca-cert.pem" "$work/cards/$id/ca-cert.pem" || known=different
    fi
    reached=null
    if [ "$try" = reach ] && [ "$id" != "$COMPANY_ID" ]; then
      reached="$(reach "$work/cards" "$id")"
    fi
    jq -c --arg print "$(fingerprint "$work/cards/$id/ca-cert.pem")" --arg known "$known" --arg me "$COMPANY_ID" --argjson reach "$reached" \
      '{id, name, color: (.color // "#4b6bfb"), peer, orderer, fingerprint: $print, known: $known, self: (.id == $me), reach: $reach}' "$work/cards/$id/card.json"
  done >"$work/members"
  jq -n --arg channel "$channel" --arg name "$(jq -r '.name // empty | tostring' "$file" | head -c 40)" \
    --arg by "$(jq -r '.createdBy // empty | tostring' "$file")" --arg at "$(jq -r '.createdAt // empty | tostring' "$file")" \
    --argjson joined "$([ -f "$WORKSPACES/$channel/workspace.json" ] && echo true || echo false)" --slurpfile members "$work/members" \
    '{channel: $channel, name: $name, createdBy: $by, createdAt: $at, joined: $joined, members: $members}' >"$work/summary.json"
}

# workspace_accept <invitation file>: checks an invitation and, if it holds, joins this company's
# orderer and peer to the workspace. Prints the summary.
workspace_accept() {
  local file="$1" work channel dir id ids name
  work="$(mktemp -d)"
  check_invitation "$file" "$work"
  channel="$(jq -r '.channel' "$work/summary.json")"
  dir="$WORKSPACES/$channel"
  if [ ! -f "$dir/workspace.json" ]; then
    mapfile -t ids <"$work/ids"
    for id in "${ids[@]}"; do keep_card "$work/cards/$id/card.json" >/dev/null; done
    mkdir -p "$dir"
    cp "$work/genesis.block" "$dir/genesis.block"
    join_nodes "$channel" "$dir/genesis.block"
    name="$(jq -r '.name' "$work/summary.json")"
    [ -n "$name" ] || name="Shared workspace"
    jq -c . "$file" >"$dir/invitation.json"
    jq -n --arg channel "$channel" --arg name "$name" --arg by "$(jq -r '.createdBy' "$work/summary.json")" \
      --arg at "$(jq -r '.createdAt' "$work/summary.json")" --args \
      '{channel: $channel, name: $name, members: $ARGS.positional, createdBy: $by, createdAt: $at, home: false}' "${ids[@]}" >"$dir/workspace.json"
    set_status "$channel" waiting '{}' >&2
  fi
  jq -c '.joined = true' "$work/summary.json"
  rm -rf "$work"
}

# Whether this company's orderer knows who leads a workspace. It does once more than half of the
# workspace's orderers have joined and can reach each other.
leader_known() {
  local metrics
  metrics="$(curl -s --max-time 3 "http://$ORDERER_HOST:9443/metrics" || true)"
  grep -Eq "^consensus_etcdraft_(is_leader\{channel=\"$1\"\} 1|leader_changes\{channel=\"$1\"\} [1-9])" <<<"$metrics"
}

# workspace_settle <channel>: takes a workspace one step nearer to being usable, if it is not yet.
# The rules come into force like this: every company approves them for itself, and once more than
# half have, any one of them commits. Each company's node does its part as soon as it can, so
# nobody has to click twice or wait for anybody in particular.
workspace_settle() {
  local channel="$1" dir="$WORKSPACES/$1" ids id count approvals definition targets=()
  [ -f "$dir/workspace.json" ] || return 0
  [ "$(jq -r '.status' "$dir/status.json" 2>/dev/null || true)" != "ready" ] || return 0
  definition=(-C "$channel" -n "$CC_NAME" -v "$CC_VERSION" --sequence "$CC_SEQUENCE")

  local committed
  committed="$(peer lifecycle chaincode querycommitted -C "$channel" -n "$CC_NAME" --output json 2>/dev/null || true)"
  if [ "$(jq -r '.sequence // 0' <<<"$committed" 2>/dev/null || true)" = "$CC_SEQUENCE" ]; then
    # The rules are in force. A company that joined after that still has to approve them for
    # itself: until it has, its own peer will not run them, and so cannot endorse anything. The
    # workspace would then lean on the other companies' peers alone.
    if [ "$(jq -r --arg id "$COMPANY_ID" '.approvals[$id] // false' <<<"$committed")" != "true" ]; then
      set_status "$channel" agreeing "$(jq -c '.approvals // {}' <<<"$committed")"
      peer lifecycle chaincode approveformyorg "${ORDERER[@]}" "${definition[@]}" --package-id "$(cat "$NODE/chaincode/package.id")" --waitForEventTimeout 20s >/dev/null 2>&1 || true
      return 0
    fi
    # Ask for the directory once, so the peer connects to its chaincode now rather than on the first
    # message. Only when it answers is the workspace ready for people.
    peer chaincode query -C "$channel" -n "$CC_NAME" -c '{"Args":["Directory"]}' >/dev/null 2>&1 || return 0
    set_status "$channel" ready '{}'
    return 0
  fi
  # Nothing can be ordered until enough of the workspace's orderers have joined.
  leader_known "$channel" || return 0

  approvals="$(peer lifecycle chaincode checkcommitreadiness "${definition[@]}" --output json 2>/dev/null | jq -c '.approvals // {}' || echo '{}')"
  if [ "$(jq -r --arg id "$COMPANY_ID" '.[$id] // false' <<<"$approvals")" != "true" ]; then
    peer lifecycle chaincode approveformyorg "${ORDERER[@]}" "${definition[@]}" --package-id "$(cat "$NODE/chaincode/package.id")" --waitForEventTimeout 20s >/dev/null 2>&1 || true
    approvals="$(peer lifecycle chaincode checkcommitreadiness "${definition[@]}" --output json 2>/dev/null | jq -c '.approvals // {}' || echo '{}')"
  fi
  set_status "$channel" agreeing "$approvals"

  mapfile -t ids < <(jq -r '.members[]' "$dir/workspace.json")
  count="$(jq '[.[] | select(. == true)] | length' <<<"$approvals")"
  if [ "$(jq -r --arg id "$COMPANY_ID" '.[$id] // false' <<<"$approvals")" = "true" ] && [ $((count * 2)) -gt "${#ids[@]}" ]; then
    # The peers of the companies that approved endorse the commit. Each checks its own company's approval first.
    for id in "${ids[@]}"; do
      [ "$(jq -r --arg id "$id" '.[$id] // false' <<<"$approvals")" = "true" ] || continue
      targets+=(--peerAddresses "$(jq -r '.peer' "$COMPANIES/$id/card.json")" --tlsRootCertFiles "$COMPANIES/$id/ca-cert.pem")
    done
    peer lifecycle chaincode commit "${ORDERER[@]}" "${definition[@]}" "${targets[@]}" --waitForEventTimeout 20s >/dev/null 2>&1 || true
  fi
}
