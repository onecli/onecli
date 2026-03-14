#!/bin/sh
set -eu

: "${ONECLI_AGENT_TOKEN:?ONECLI_AGENT_TOKEN is required. Copy the agent token from the OneCLI dashboard.}"

case "$ONECLI_AGENT_TOKEN" in
  aoc_*)
    ;;
  *)
    echo "ONECLI_AGENT_TOKEN must be an agent token starting with 'aoc_'"
    echo "It looks like you may be using an API key (oc_...)."
    exit 1
    ;;
esac

GATEWAY_PROXY="${GATEWAY_PROXY:-http://localhost:10254}"
TARGET_URL_BEARER="${TARGET_URL_BEARER:-https://httpbin.org/bearer}"
TARGET_URL_ANYTHING="${TARGET_URL_ANYTHING:-https://httpbin.org/anything}"
CA_CERT="${CA_CERT:-/onecli-data/gateway/ca.pem}"

if [ ! -f "$CA_CERT" ]; then
  echo "CA certificate not found at $CA_CERT"
  echo "Make sure onecli has generated gateway CA and onecli-data volume is mounted."
  exit 1
fi

call_target() {
  target_url="$1"

  echo "Calling $target_url through proxy $GATEWAY_PROXY"

  curl -sS --fail-with-body \
    --proxy "$GATEWAY_PROXY" \
    --proxy-user "x:${ONECLI_AGENT_TOKEN}" \
    --cacert "$CA_CERT" \
    "$target_url"

  echo
}

call_target "$TARGET_URL_BEARER"
call_target "$TARGET_URL_ANYTHING"
