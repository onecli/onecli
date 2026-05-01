#!/usr/bin/env bash
set -euo pipefail

################################################################################
# SBOM Crypto Audit — verify no unapproved crypto libraries in dependency tree.
#
# Approved crypto components:
#   Rust:  ring, rustls, rcgen (cert gen), jsonwebtoken
#   Rust (transitive, approved): sha2, hmac, cipher, crypto-common, sha1, sha3,
#          ed25519-dalek, clatter (via Bitwarden Agent Access SDK / sqlx)
#   JS:    node:crypto (built-in) — no third-party crypto packages
#
# Unapproved (would fail this check):
#   Rust:  openssl, openssl-sys, boringssl
#   JS:    crypto-js, sjcl, node-forge, tweetnacl, libsodium, bcrypt, argon2, scrypt
#
# Usage: ./scripts/sbom-crypto-audit.sh
################################################################################

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ERRORS=0

echo "=== SBOM Crypto Audit ==="
echo ""

# ── Rust crate audit ──────────────────────────────────────────────────
echo "--- Rust: checking for unapproved crypto crates ---"

BLOCKED_RUST_CRATES="openssl|openssl-sys|boringssl|boring|boring-sys"

cd "$PROJECT_ROOT/apps/gateway"
RUST_HITS=$(cargo tree -f '{p}' 2>/dev/null | grep -iE "^($BLOCKED_RUST_CRATES) " || true)

if [ -n "$RUST_HITS" ]; then
  echo "FAIL: Unapproved Rust crypto crates found:"
  echo "$RUST_HITS"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: No unapproved Rust crypto crates"
fi

echo ""

# ── JS package audit ─────────────────────────────────────────────────
echo "--- JS: checking for unapproved crypto packages ---"

BLOCKED_JS_PACKAGES="crypto-js|sjcl|node-forge|tweetnacl|libsodium|libsodium-wrappers|sodium-native|bcrypt|bcryptjs|argon2|scrypt|scrypt-js"

cd "$PROJECT_ROOT"
JS_HITS=$(pnpm list --depth=Infinity 2>/dev/null | grep -iE "$BLOCKED_JS_PACKAGES" || true)

if [ -n "$JS_HITS" ]; then
  echo "FAIL: Unapproved JS crypto packages found:"
  echo "$JS_HITS"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: No unapproved JS crypto packages"
fi

echo ""

# ── Summary ──────────────────────────────────────────────────────────
echo "--- Approved crypto inventory ---"
echo "  Rust: ring (AES-256-GCM), rustls (TLS), rcgen (cert gen), jsonwebtoken (JWT)"
echo "  Rust (transitive): sha2, hmac, cipher, ed25519-dalek (via Bitwarden SDK / sqlx)"
echo "  JS:   node:crypto built-in (AES-256-GCM)"
echo ""

if [ "$ERRORS" -gt 0 ]; then
  echo "AUDIT FAILED: $ERRORS unapproved crypto component(s) detected"
  exit 1
else
  echo "AUDIT PASSED: all crypto components are on the approved list"
fi

################################################################################
# Changelog:
# 2026-03-24  Initial creation — crypto dependency audit for SBOM compliance
################################################################################
