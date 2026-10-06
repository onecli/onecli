-- When the provider refused this connection's OAuth refresh token
-- (`invalid_grant`): the account must be reconnected before it can be used
-- again. Set by the gateway, cleared by any reconnect. NULL = healthy.
-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN "reauth_required_at" TIMESTAMP(3);
