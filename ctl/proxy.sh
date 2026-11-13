#!/bin/bash
# ctl proxy: answers for the chat over HTTPS, and hands each request on to the chat app.
#
# It runs only when company.json asks for HTTPS. It gets the certificate for the chat's name by
# itself and renews it by itself: from Let's Encrypt, from another certificate authority that
# speaks the same protocol, or signed by itself for a private network.
# It holds no key of the company's node: only the certificate for the chat's own name, in the
# "proxy" volume.
source "$(dirname "$0")/lib.sh"
read_company
[ "$HTTPS" != off ] || fail "company.json does not ask for HTTPS, so there is nothing for the proxy to do."

home=/proxy
mkdir -p "$home/data" "$home/config"
if [ -n "$HTTPS_ROOT" ]; then
  printf '%s\n' "$HTTPS_ROOT" >"$home/authority-root.pem"
fi

{
  echo "{"
  echo "	admin off"
  if [ -n "$HTTPS_EMAIL" ]; then
    echo "	email $HTTPS_EMAIL"
  fi
  if [ -n "$HTTPS_AUTHORITY" ]; then
    echo "	acme_ca $HTTPS_AUTHORITY"
    if [ -n "$HTTPS_ROOT" ]; then
      echo "	acme_ca_root $home/authority-root.pem"
    fi
  fi
  if [ "$LISTEN_PORT" != 443 ]; then
    # Sending plain HTTP on to HTTPS only works when HTTPS is where browsers expect it.
    echo "	auto_https disable_redirects"
  fi
  echo "}"
  echo
  echo "$CHAT_HOST {"
  if [ "$HTTPS" = self-signed ]; then
    echo "	tls internal"
  fi
  # A browser that has been here once will not use plain HTTP for this name again.
  echo '	header Strict-Transport-Security "max-age=31536000"'
  echo "	reverse_proxy app:8080"
  echo "}"
} >"$home/Caddyfile"

authority="Let's Encrypt"
if [ -n "$HTTPS_AUTHORITY" ]; then
  authority="$HTTPS_AUTHORITY"
fi
if [ "$HTTPS" = self-signed ]; then
  echo "HTTPS for $CHAT_HOST with a certificate this server signs itself. Browsers will warn about it."
else
  echo "HTTPS for $CHAT_HOST with a certificate from $authority"
fi
export XDG_DATA_HOME="$home/data" XDG_CONFIG_HOME="$home/config"
exec caddy run --config "$home/Caddyfile" --adapter caddyfile
