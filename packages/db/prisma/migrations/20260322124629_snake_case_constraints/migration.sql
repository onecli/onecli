-- AlterTable
ALTER TABLE "agent" RENAME CONSTRAINT "Agent_pkey" TO "agent_pkey";

-- AlterTable
ALTER TABLE "agent_secret" RENAME CONSTRAINT "AgentSecret_pkey" TO "agent_secret_pkey";

-- AlterTable
ALTER TABLE "audit_log" RENAME CONSTRAINT "AuditLog_pkey" TO "audit_log_pkey";

-- AlterTable
ALTER TABLE "connected_service" RENAME CONSTRAINT "ConnectedService_pkey" TO "connected_service_pkey";

-- AlterTable
ALTER TABLE "policy_rule" RENAME CONSTRAINT "PolicyRule_pkey" TO "policy_rule_pkey";

-- AlterTable
ALTER TABLE "secret" RENAME CONSTRAINT "Secret_pkey" TO "secret_pkey";

-- AlterTable
ALTER TABLE "user" RENAME CONSTRAINT "User_pkey" TO "user_pkey";

-- AlterTable
ALTER TABLE "vault_connection" RENAME CONSTRAINT "VaultConnection_pkey" TO "vault_connection_pkey";

-- RenameForeignKey
ALTER TABLE "agent" RENAME CONSTRAINT "Agent_userId_fkey" TO "agent_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "agent_secret" RENAME CONSTRAINT "AgentSecret_agentId_fkey" TO "agent_secret_agent_id_fkey";

-- RenameForeignKey
ALTER TABLE "agent_secret" RENAME CONSTRAINT "AgentSecret_secretId_fkey" TO "agent_secret_secret_id_fkey";

-- RenameForeignKey
ALTER TABLE "audit_log" RENAME CONSTRAINT "AuditLog_userId_fkey" TO "audit_log_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "connected_service" RENAME CONSTRAINT "ConnectedService_userId_fkey" TO "connected_service_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "policy_rule" RENAME CONSTRAINT "PolicyRule_agentId_fkey" TO "policy_rule_agent_id_fkey";

-- RenameForeignKey
ALTER TABLE "policy_rule" RENAME CONSTRAINT "PolicyRule_userId_fkey" TO "policy_rule_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "secret" RENAME CONSTRAINT "Secret_userId_fkey" TO "secret_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "vault_connection" RENAME CONSTRAINT "VaultConnection_userId_fkey" TO "vault_connection_user_id_fkey";

-- RenameIndex
ALTER INDEX "Agent_accessToken_key" RENAME TO "agent_access_token_key";

-- RenameIndex
ALTER INDEX "Agent_userId_identifier_key" RENAME TO "agent_user_id_identifier_key";

-- RenameIndex
ALTER INDEX "Agent_userId_idx" RENAME TO "agent_user_id_idx";

-- RenameIndex
ALTER INDEX "AuditLog_userId_createdAt_idx" RENAME TO "audit_log_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "ConnectedService_userId_provider_key" RENAME TO "connected_service_user_id_provider_key";

-- RenameIndex
ALTER INDEX "PolicyRule_userId_idx" RENAME TO "policy_rule_user_id_idx";

-- RenameIndex
ALTER INDEX "Secret_userId_idx" RENAME TO "secret_user_id_idx";

-- RenameIndex
ALTER INDEX "User_apiKey_key" RENAME TO "user_api_key_key";

-- RenameIndex
ALTER INDEX "User_email_key" RENAME TO "user_email_key";

-- RenameIndex
ALTER INDEX "User_externalAuthId_key" RENAME TO "user_external_auth_id_key";

-- RenameIndex
ALTER INDEX "User_stripeCustomerId_key" RENAME TO "user_stripe_customer_id_key";

-- RenameIndex
ALTER INDEX "VaultConnection_userId_provider_key" RENAME TO "vault_connection_user_id_provider_key";
