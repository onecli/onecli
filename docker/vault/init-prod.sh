#!/bin/sh
set -eu

VAULT_ADDR="${VAULT_ADDR:-http://vault-prod:8200}"
export VAULT_ADDR

BOOTSTRAP_DIR="${VAULT_BOOTSTRAP_DIR:-/vault/bootstrap}"
INIT_FILE="$BOOTSTRAP_DIR/init.txt"
UNSEAL_KEY_FILE="$BOOTSTRAP_DIR/unseal_key"
ROOT_TOKEN_FILE="$BOOTSTRAP_DIR/root_token"

mkdir -p "$BOOTSTRAP_DIR"

wait_for_vault() {
  echo "Waiting for Vault at $VAULT_ADDR ..."
  i=0
  until vault status >/dev/null 2>&1; do
    code=$?
    # 0 = unsealed, 2 = sealed/uninitialized but reachable
    if [ "$code" -eq 0 ] || [ "$code" -eq 2 ]; then
      break
    fi
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      echo "Vault did not become ready in time"
      exit 1
    fi
    sleep 2
  done
}

is_initialized() {
  vault operator init -status >/dev/null 2>&1
}

is_sealed() {
  vault status >/dev/null 2>&1
  code=$?
  [ "$code" -eq 2 ]
}

extract_init_values() {
  if [ ! -s "$UNSEAL_KEY_FILE" ]; then
    sed -n 's/^Unseal Key 1:[[:space:]]*//p' "$INIT_FILE" >"$UNSEAL_KEY_FILE"
    chmod 600 "$UNSEAL_KEY_FILE"
  fi

  if [ ! -s "$ROOT_TOKEN_FILE" ]; then
    sed -n 's/^Initial Root Token:[[:space:]]*//p' "$INIT_FILE" >"$ROOT_TOKEN_FILE"
    chmod 600 "$ROOT_TOKEN_FILE"
  fi

  if [ ! -s "$UNSEAL_KEY_FILE" ] || [ ! -s "$ROOT_TOKEN_FILE" ]; then
    echo "Failed to extract unseal key or root token from $INIT_FILE"
    exit 1
  fi
}

initialize_if_needed() {
  if is_initialized; then
    echo "Vault already initialized"
    return
  fi

  echo "Initializing Vault (single-node, key-threshold=1)"
  vault operator init -key-shares=1 -key-threshold=1 >"$INIT_FILE"
  chmod 600 "$INIT_FILE"
  extract_init_values

  if ! is_initialized; then
    echo "Vault init command completed but Vault is still uninitialized"
    exit 1
  fi
}

unseal_if_needed() {
  if ! is_sealed; then
    echo "Vault already unsealed"
    return
  fi

  if [ ! -s "$UNSEAL_KEY_FILE" ]; then
    extract_init_values
  fi

  UNSEAL_KEY="$(cat "$UNSEAL_KEY_FILE")"
  echo "Unsealing Vault"
  vault operator unseal "$UNSEAL_KEY" >/dev/null

  if is_sealed; then
    echo "Vault is still sealed after unseal operation"
    exit 1
  fi
}

configure_kv() {
  ROOT_TOKEN="$(cat "$ROOT_TOKEN_FILE")"
  export VAULT_TOKEN="$ROOT_TOKEN"

  if ! vault secrets list | grep -q '^secret/'; then
    echo "Enabling kv-v2 mount at secret/"
    vault secrets enable -path=secret kv-v2 >/dev/null
  fi

  vault kv put secret/onecli/bootstrap value=ok >/dev/null
  echo "Vault bootstrap secret written"
}

wait_for_vault
initialize_if_needed
unseal_if_needed
configure_kv

if ! is_initialized; then
  echo "Vault verification failed: not initialized"
  exit 1
fi

vault status >/dev/null 2>&1
status_code=$?
if [ "$status_code" -ne 0 ]; then
  echo "Vault verification failed: expected unsealed status, got exit code $status_code"
  exit 1
fi

echo "Vault production initialization complete"
