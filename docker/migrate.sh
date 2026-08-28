#!/bin/sh
set -e

# One-shot database migration runner, baked into the dedicated migrations
# image (docker/migrations.Dockerfile). The compose `migrations` service
# (self-host) and the cloud migration task both run this to completion before
# any serving container starts — the servers themselves never migrate.
#
# DATABASE_URL may be preset, or assembled from DB_* parts (the cloud task
# injects DB_HOST plus DB_USERNAME/DB_PASSWORD from Secrets Manager; the
# password is URL-encoded because RDS-managed passwords can contain special
# characters).
if [ -z "$DATABASE_URL" ] && [ -n "$DB_HOST" ]; then
  ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.env.DB_PASSWORD ?? ""))')
  export DATABASE_URL="postgresql://${DB_USERNAME}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME:-onecli}"
fi

# PRISMA_CMD / PRISMA_SCHEMA exist solely so the test suite can run this
# script against a stubbed CLI (scripts/migrate-sh.test.mjs).
PRISMA="${PRISMA_CMD:-node /app/packages/db/node_modules/prisma/build/index.js}"
SCHEMA="${PRISMA_SCHEMA:-/app/packages/db/prisma/schema.prisma}"

echo "Applying database migrations..."
if OUTPUT=$($PRISMA migrate deploy --schema "$SCHEMA" 2>&1); then
  echo "$OUTPUT"
  echo "Database migrations applied."
  exit 0
fi
echo "$OUTPUT"

case "$OUTPUT" in
  *P3005*)
    # P3005 only: a non-empty database without a _prisma_migrations table — a
    # pre-migration-history install. Baseline 0_init as applied, then deploy
    # the rest. Any other failure (a failed migration row, bad credentials,
    # drift) must surface loudly, never be auto-"repaired".
    echo "Existing schema without migration history (P3005) — baselining 0_init..."
    $PRISMA migrate resolve --applied 0_init --schema "$SCHEMA"
    $PRISMA migrate deploy --schema "$SCHEMA"
    ;;
  *)
    {
      echo ""
      echo "Database migration failed — not attempting automatic repair."
      echo "Dependent services will not start until this is resolved."
      echo "  Inspect: docker compose logs migrations"
      echo "  Retry:   docker compose up -d"
      echo "A previously failed migration (P3009) needs manual resolution:"
      echo "  https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing"
    } >&2
    exit 1
    ;;
esac
