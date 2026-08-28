#!/bin/sh
set -e

# The step-2 live loop (plans/hosted-agents-v2.md step 2 verify): fetch the
# agent's container-config, run the agent image with ONLY placeholder
# credentials inside, pipe one turn over stdin, and watch the model's real
# answer stream back as canonical events — every byte injected at the wire
# by the gateway.
#
# Prereqs:
#   - dev api (:10256) and gateway (:10255) running, GATEWAY_CA_PEM_FILE set
#     for the api so /v1/container-config can serve the CA
#   - an agent (identifier below) granted an Anthropic secret in the workspace
#   - the image: docker build -f docker/agent.Dockerfile -t onecli-agent:dev .
#   - jq
#
# Usage:
#   ONECLI_API_KEY=oc_... WORKSPACE_ID=... AGENT=my-agent \
#     apps/sandbox-supervisor/dev/run-local.sh

API_URL="${API_URL:-http://localhost:10256}"
AGENT="${AGENT:?set AGENT=<agent identifier>}"
WORKSPACE_ID="${WORKSPACE_ID:?set WORKSPACE_ID=<workspace id>}"
API_KEY="${ONECLI_API_KEY:?set ONECLI_API_KEY=<oc_... api key>}"
PROMPT="${PROMPT:-Reply with exactly the two words: HOSTED LIVES}"

echo "── fetching container-config for agent '$AGENT' ──" >&2
CFG=$(curl -fsS \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  "$API_URL/v1/container-config?agent=$AGENT")

CA_PATH=$(printf '%s' "$CFG" | jq -r .caCertificateContainerPath)
TMP=$(mktemp -d)
printf '%s' "$CFG" | jq -r .caCertificate >"$TMP/ca.pem"
printf '%s' "$CFG" | jq -r '.warnings // [] | .[]' | sed 's/^/WARNING: /' >&2

# Server-controlled env, fanned out as -e flags (values are URLs/flags —
# never whitespace), exactly what the node-sdk's applyContainerConfig does.
ENV_FLAGS=$(printf '%s' "$CFG" | jq -r '.env | to_entries[] | "-e \(.key)=\(.value)"')

EXTRA=""
[ "$(uname)" = "Linux" ] && EXTRA="--add-host host.docker.internal:host-gateway"

echo "── running one turn (placeholders only inside the container) ──" >&2
# shellcheck disable=SC2086
printf '{"kind":"turn.deliver","turnId":"live-1","message":%s}\n{"kind":"shutdown"}\n' \
  "$(printf '%s' "$PROMPT" | jq -Rs .)" |
  docker run -i --rm $EXTRA \
    -v "$TMP/ca.pem:$CA_PATH:ro" \
    $ENV_FLAGS \
    ${AGENT_MODEL:+-e AGENT_MODEL="$AGENT_MODEL"} \
    -e AGENT_INSTRUCTIONS="You are the OneCLI live-proof agent." \
    onecli-agent:dev
