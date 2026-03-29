-- Add OAuth2 auto-refresh support to secrets table.
-- For oauth2 secrets, the main encrypted_value stores the service account key
-- or refresh token. The encrypted_access_token stores the auto-refreshed
-- access token that the gateway actually injects.

ALTER TABLE "secrets" ADD COLUMN "encrypted_access_token" TEXT;
ALTER TABLE "secrets" ADD COLUMN "access_token_expires_at" TIMESTAMP(3);
ALTER TABLE "secrets" ADD COLUMN "last_refresh_error" TEXT;
