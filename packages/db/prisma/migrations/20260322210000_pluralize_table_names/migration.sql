-- Rename all tables from singular to plural (ActiveRecord convention)
ALTER TABLE "user" RENAME TO "users";
ALTER TABLE "agent" RENAME TO "agents";
ALTER TABLE "secret" RENAME TO "secrets";
ALTER TABLE "policy_rule" RENAME TO "policy_rules";
ALTER TABLE "agent_secret" RENAME TO "agent_secrets";
ALTER TABLE "connected_service" RENAME TO "connected_services";
ALTER TABLE "audit_log" RENAME TO "audit_logs";
ALTER TABLE "vault_connection" RENAME TO "vault_connections";
