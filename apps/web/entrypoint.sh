#!/bin/sh
set -e

PRISMA="node /app/packages/db/node_modules/prisma/build/index.js"
SCHEMA="--schema /app/packages/db/prisma/schema.prisma"

# Generate proxy–API shared secret if not already present.
# The proxy reads this file to authenticate requests to /api/proxy/* endpoints.
# In cloud mode, PROXY_SECRET env var is used instead (from Secrets Manager).
if [ -z "$PROXY_SECRET" ]; then
  PROXY_SECRET_FILE="${PROXY_SECRET_FILE:-/app/data/proxy-secret}"
  if [ ! -f "$PROXY_SECRET_FILE" ] || [ ! -s "$PROXY_SECRET_FILE" ]; then
    echo "Generating proxy–API shared secret..."
    mkdir -p "$(dirname "$PROXY_SECRET_FILE")"
    head -c 32 /dev/urandom | xxd -p -c 64 > "$PROXY_SECRET_FILE"
    chmod 600 "$PROXY_SECRET_FILE"
  fi
fi

if [ -n "$DATABASE_URL" ]; then
  echo "External database detected, running Prisma migrations..."
  if ! $PRISMA migrate deploy $SCHEMA 2>&1; then
    echo "migrate deploy failed — bootstrapping baseline migration..."
    $PRISMA migrate resolve --applied 0_init $SCHEMA
    $PRISMA migrate deploy $SCHEMA
  fi
else
  echo "No DATABASE_URL set, initializing embedded PGlite database..."
  node /app/packages/db/scripts/init-dev-db.ts
fi

# Start Next.js
exec node apps/web/server.js
