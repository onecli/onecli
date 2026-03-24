-- Rename constraints, foreign keys, and indexes to match plural table names
-- (missed in the pluralize_table_names migration)

-- Primary keys
ALTER TABLE "agent_secrets" RENAME CONSTRAINT "agent_secret_pkey" TO "agent_secrets_pkey";
ALTER TABLE "agents" RENAME CONSTRAINT "agent_pkey" TO "agents_pkey";
ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_log_pkey" TO "audit_logs_pkey";
ALTER TABLE "connected_services" RENAME CONSTRAINT "connected_service_pkey" TO "connected_services_pkey";
ALTER TABLE "policy_rules" RENAME CONSTRAINT "policy_rule_pkey" TO "policy_rules_pkey";
ALTER TABLE "secrets" RENAME CONSTRAINT "secret_pkey" TO "secrets_pkey";
ALTER TABLE "users" RENAME CONSTRAINT "user_pkey" TO "users_pkey";
ALTER TABLE "vault_connections" RENAME CONSTRAINT "vault_connection_pkey" TO "vault_connections_pkey";

-- Foreign keys
ALTER TABLE "agent_secrets" RENAME CONSTRAINT "agent_secret_agent_id_fkey" TO "agent_secrets_agent_id_fkey";
ALTER TABLE "agent_secrets" RENAME CONSTRAINT "agent_secret_secret_id_fkey" TO "agent_secrets_secret_id_fkey";
ALTER TABLE "agents" RENAME CONSTRAINT "agent_user_id_fkey" TO "agents_user_id_fkey";
ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_log_user_id_fkey" TO "audit_logs_user_id_fkey";
ALTER TABLE "connected_services" RENAME CONSTRAINT "connected_service_user_id_fkey" TO "connected_services_user_id_fkey";
ALTER TABLE "policy_rules" RENAME CONSTRAINT "policy_rule_agent_id_fkey" TO "policy_rules_agent_id_fkey";
ALTER TABLE "policy_rules" RENAME CONSTRAINT "policy_rule_user_id_fkey" TO "policy_rules_user_id_fkey";
ALTER TABLE "secrets" RENAME CONSTRAINT "secret_user_id_fkey" TO "secrets_user_id_fkey";
ALTER TABLE "vault_connections" RENAME CONSTRAINT "vault_connection_user_id_fkey" TO "vault_connections_user_id_fkey";

-- Indexes
ALTER INDEX "agent_access_token_key" RENAME TO "agents_access_token_key";
ALTER INDEX "agent_user_id_identifier_key" RENAME TO "agents_user_id_identifier_key";
ALTER INDEX "agent_user_id_idx" RENAME TO "agents_user_id_idx";
ALTER INDEX "audit_log_user_id_created_at_idx" RENAME TO "audit_logs_user_id_created_at_idx";
ALTER INDEX "connected_service_user_id_provider_key" RENAME TO "connected_services_user_id_provider_key";
ALTER INDEX "policy_rule_user_id_idx" RENAME TO "policy_rules_user_id_idx";
ALTER INDEX "secret_user_id_idx" RENAME TO "secrets_user_id_idx";
ALTER INDEX "user_api_key_key" RENAME TO "users_api_key_key";
ALTER INDEX "user_email_key" RENAME TO "users_email_key";
ALTER INDEX "user_external_auth_id_key" RENAME TO "users_external_auth_id_key";
ALTER INDEX "user_stripe_customer_id_key" RENAME TO "users_stripe_customer_id_key";
ALTER INDEX "vault_connection_user_id_provider_key" RENAME TO "vault_connections_user_id_provider_key";
