#!/bin/bash
# Prints the URLs to open, and whether the relay is actually up.
#   bash my-patterns/ipad-control/url.sh

PORT="${PORT:-9000}"
HOST="$(scutil --get LocalHostName 2>/dev/null).local"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "relay:  running on :$PORT"
else
  echo "relay:  NOT RUNNING — start it first:"
  echo "        cd $(cd "$(dirname "$0")/../.." && pwd) && node my-patterns/ipad-control/relay.mjs"
  echo
fi

echo
echo "  on this mac:   http://localhost:$PORT"
echo "  on the iPad:   http://$HOST:$PORT      <- prefer this, survives IP changes"
if [ -n "$IP" ]; then
  echo "  fallback:      http://$IP:$PORT"
  # Confirm the fallback actually answers on the LAN interface, not just loopback.
  if curl -sf -m 3 -o /dev/null "http://$IP:$PORT/" 2>/dev/null; then
    echo "                 (verified reachable)"
  else
    echo "                 (NOT responding — is the relay running?)"
  fi
else
  echo "  fallback:      no wifi address found — is wifi on?"
fi
