-- Converts existing uncustomized attaches (one whole-app allow row) into the
-- new default: every catalog tool allowed, then a whole-app needs-approval row
-- (`defaultConnectionGrant`). Catalog-less apps are excluded, like the
-- compiler. Draft and every published generation; conditions are kept and
-- priorities are doubled so the new row slots right after its source. The
-- catalog below is a snapshot; tools added later fall to the approval row.
-- Idempotent: a converted stack has two rows, so it no longer matches.
WITH catalog(provider, tools) AS (
  VALUES
    ('affinity', ARRAY['create_company', 'create_list_entry', 'create_note', 'create_person', 'delete_list_entry', 'get_company', 'get_person', 'list_companies', 'list_lists', 'list_notes', 'list_opportunities', 'list_persons', 'mcp', 'update_person']::text[]),
    ('apollo-io', ARRAY['add_to_sequence', 'bulk_enrich_companies', 'bulk_update_accounts', 'bulk_update_contacts', 'complete_task', 'create_account', 'create_contact', 'create_deal', 'create_task', 'enrich_company', 'enrich_person', 'get_account', 'get_company_job_postings', 'get_contact', 'get_deal', 'get_profile', 'get_task', 'list_deals', 'list_email_accounts', 'list_users', 'search_accounts', 'search_companies', 'search_contacts', 'search_emails', 'search_people', 'search_sequences', 'search_tasks', 'update_account', 'update_contact', 'update_deal', 'update_task']::text[]),
    ('attio', ARRAY['create_comment', 'create_list_entry', 'create_note', 'create_record', 'create_task', 'create_webhook', 'delete_list_entry', 'delete_note', 'delete_record', 'delete_task', 'delete_webhook', 'get_list', 'get_note', 'get_object', 'get_record', 'get_task', 'get_webhook', 'get_workspace_member', 'list_comments', 'list_entries', 'list_lists', 'list_notes', 'list_objects', 'list_records', 'list_tasks', 'list_webhooks', 'list_workspace_members', 'self', 'update_list_entry', 'update_record', 'update_task', 'update_webhook']::text[]),
    ('aws', ARRAY['cloudformation_access', 'cloudwatch_logs_access', 'dynamodb_access', 'ec2_access', 'iam_access', 'lambda_delete', 'lambda_get_function', 'lambda_invoke', 'lambda_list_functions', 's3_delete', 's3_list_buckets', 's3_read_objects', 's3_upload', 'secrets_manager_access', 'ses_send', 'sts_access']::text[]),
    ('aws-role', ARRAY['cloudformation_access', 'cloudwatch_logs_access', 'dynamodb_access', 'ec2_access', 'iam_access', 'lambda_delete', 'lambda_get_function', 'lambda_invoke', 'lambda_list_functions', 's3_delete', 's3_list_buckets', 's3_read_objects', 's3_upload', 'secrets_manager_access', 'ses_send', 'sts_access']::text[]),
    ('circleback', ARRAY['create_action_item', 'delete_action_item', 'delete_meeting', 'get_account', 'get_company', 'get_meeting', 'get_person', 'get_transcript', 'import_meeting', 'list_action_items', 'list_calendar_events', 'list_companies', 'list_meetings', 'list_people', 'list_tags', 'manage_tags', 'search_meetings', 'share_meeting', 'update_action_item', 'update_calendar_event_meeting', 'update_meeting']::text[]),
    ('clay', ARRAY['get_credit_balance', 'get_me', 'get_routine_results', 'query_tables', 'run_routine', 'run_routine_batch', 'search', 'search_reference', 'search_workflow_runs']::text[]),
    ('cloudflare', ARRAY['create_dns_record', 'delete_dns_record', 'delete_worker', 'deploy_worker', 'get_zone', 'list_d1_databases', 'list_dns_records', 'list_kv_namespaces', 'list_pages_projects', 'list_r2_buckets', 'list_workers', 'list_zones', 'purge_cache', 'query_d1', 'update_dns_record', 'write_kv']::text[]),
    ('confluence', ARRAY['create_comment', 'create_page', 'delete_page', 'get_page', 'get_space', 'list_pages', 'list_spaces', 'search_content', 'update_page']::text[]),
    ('datadog', ARRAY['apm_services', 'dashboards_create', 'dashboards_delete', 'dashboards_get', 'dashboards_list', 'dashboards_update', 'events_list', 'events_post', 'hosts_list', 'logs_config_read', 'logs_search', 'logs_submit', 'metrics_list', 'metrics_query', 'monitors_create', 'monitors_delete', 'monitors_get', 'monitors_list', 'monitors_update', 'slos_list']::text[]),
    ('docker', ARRAY['create_repository', 'delete_repository', 'delete_tag', 'get_namespace', 'get_repository', 'get_user', 'list_orgs', 'list_repositories', 'list_tags', 'update_repository']::text[]),
    ('dropbox', ARRAY['create_folder', 'create_shared_link', 'delete_file', 'download_file', 'get_current_account', 'get_metadata', 'list_folder', 'list_shared_links', 'move_file', 'search_files', 'upload_file']::text[]),
    ('fathom', ARRAY['create_webhook', 'delete_webhook', 'get_recording_summary', 'get_recording_transcript', 'list_meetings', 'list_team_members', 'list_teams']::text[]),
    ('fireflies', ARRAY['graphql_mutation', 'graphql_query', 'mcp_access']::text[]),
    ('flyio', ARRAY['create_app', 'create_machine', 'create_volume', 'delete_app', 'delete_machine', 'delete_volume', 'get_app', 'get_machine', 'get_volume', 'graphql', 'list_apps', 'list_machines', 'list_volumes', 'manage_secrets', 'start_machine', 'stop_machine', 'update_machine']::text[]),
    ('github', ARRAY['create_comment', 'create_issue', 'create_pull', 'delete_branch', 'get_repo', 'git_clone', 'git_push', 'graphql_mutation', 'graphql_query', 'list_issues', 'list_pulls', 'list_repos', 'read_raw_content', 'search', 'update_issue', 'update_pull']::text[]),
    ('github-app', ARRAY['create_comment', 'create_issue', 'create_pull', 'delete_branch', 'get_repo', 'git_clone', 'git_push', 'graphql_mutation', 'graphql_query', 'list_issues', 'list_pulls', 'list_repos', 'read_raw_content', 'search', 'update_issue', 'update_pull']::text[]),
    ('gitlab', ARRAY['create_branch', 'create_issue', 'create_issue_note', 'create_merge_request', 'create_mr_note', 'delete_branch', 'get_issue', 'get_merge_request', 'get_project', 'list_branches', 'list_issues', 'list_merge_requests', 'list_projects', 'merge_merge_request', 'update_issue', 'update_merge_request']::text[]),
    ('gmail', ARRAY['batch_delete_messages', 'batch_modify_messages', 'create_draft', 'delete_draft', 'delete_message', 'delete_thread', 'get_message', 'get_profile', 'get_thread', 'import_message', 'insert_message', 'list_drafts', 'list_labels', 'modify_message', 'modify_thread', 'search_messages', 'search_threads', 'send_draft', 'send_email', 'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread', 'update_draft']::text[]),
    ('google-admin', ARRAY['create_user', 'delete_user', 'get_user', 'list_groups', 'list_users', 'update_user']::text[]),
    ('google-analytics', ARRAY['batch_run_reports', 'get_metadata', 'run_report']::text[]),
    ('google-calendar', ARRAY['create_event', 'delete_event', 'get_calendar', 'get_event', 'list_calendars', 'list_events', 'update_event']::text[]),
    ('google-chat', ARRAY['create_member', 'create_message', 'create_space', 'delete_member', 'delete_message', 'delete_space', 'get_member', 'get_message', 'get_space', 'list_members', 'list_messages', 'list_spaces', 'update_message', 'update_space']::text[]),
    ('google-classroom', ARRAY['create_course', 'create_coursework', 'get_course', 'list_courses', 'list_students', 'update_course']::text[]),
    ('google-contacts', ARRAY['create_contact', 'delete_contact', 'get_person', 'list_connections', 'list_directory', 'list_other_contacts', 'search_contacts', 'search_directory', 'search_other_contacts', 'update_contact']::text[]),
    ('google-docs', ARRAY['batch_update_document', 'create_document', 'get_document']::text[]),
    ('google-drive', ARRAY['create_file', 'delete_file', 'get_file', 'get_file_metadata', 'list_files', 'search_files', 'share_file', 'update_file']::text[]),
    ('google-forms', ARRAY['batch_update_form', 'create_form', 'get_form', 'list_responses']::text[]),
    ('google-meet', ARRAY['create_space', 'end_call', 'get_space', 'list_recordings']::text[]),
    ('google-photos', ARRAY['batch_add_to_album', 'create_album', 'get_media_item', 'list_albums', 'list_media_items', 'upload_media']::text[]),
    ('google-search-console', ARRAY['add_site', 'delete_site', 'get_site', 'list_sites', 'search_analytics_query']::text[]),
    ('google-sheets', ARRAY['append_values', 'batch_get_values', 'batch_update_values', 'create_spreadsheet', 'get_spreadsheet', 'get_values', 'update_values']::text[]),
    ('google-slides', ARRAY['batch_update_presentation', 'create_presentation', 'get_page', 'get_presentation']::text[]),
    ('google-tasks', ARRAY['create_task', 'delete_task', 'get_task', 'list_task_lists', 'list_tasks', 'update_task']::text[]),
    ('granola', ARRAY['get_note', 'list_folders', 'list_notes']::text[]),
    ('hubspot', ARRAY['create_association', 'create_company', 'create_contact', 'create_deal', 'create_ticket', 'delete_association', 'get_company', 'get_contact', 'get_deal', 'get_ticket', 'list_associations', 'list_companies', 'list_contacts', 'list_deals', 'list_owners', 'list_tickets', 'search_crm', 'update_company', 'update_contact', 'update_deal', 'update_ticket']::text[]),
    ('jira', ARRAY['add_comment', 'assign_issue', 'create_issue', 'delete_issue', 'get_issue', 'get_project', 'list_projects', 'search_issues', 'transition_issue', 'update_issue']::text[]),
    ('linear', ARRAY['create_comment', 'create_issue', 'delete_issue', 'get_issue', 'list_issues', 'list_labels', 'list_projects', 'list_teams', 'search', 'update_issue']::text[]),
    ('linkedin', ARRAY['create_comment', 'create_post', 'create_reaction', 'delete_comment', 'delete_post', 'delete_reaction', 'get_posts', 'get_profile']::text[]),
    ('microsoft-onenote', ARRAY['create_notebook', 'create_page', 'create_section', 'delete_page', 'get_notebook', 'get_page_content', 'list_notebook_sections', 'list_notebooks', 'list_pages', 'list_section_pages', 'list_sections', 'update_page']::text[]),
    ('microsoft-word', ARRAY['create_folder', 'delete_file', 'download_file', 'get_file', 'list_files', 'search_files', 'update_file', 'upload_file']::text[]),
    ('monday', ARRAY['manage_webhooks', 'mutate_boards', 'mutate_docs', 'mutate_updates', 'query_boards', 'query_docs', 'query_updates', 'query_users', 'query_workspaces', 'send_notifications']::text[]),
    ('mongodb-atlas', ARRAY['add_access_list', 'create_cluster', 'create_db_user', 'create_project', 'delete_access_list', 'delete_cluster', 'delete_db_user', 'get_cluster', 'get_project', 'list_access_list', 'list_alerts', 'list_clusters', 'list_db_users', 'list_orgs', 'list_projects', 'update_cluster', 'update_db_user']::text[]),
    ('navan', ARRAY['get_custom_field', 'get_gl_code', 'get_gl_code_settings', 'get_tax_mapping', 'get_transaction', 'list_adjustments', 'list_bookings', 'list_card_transactions', 'list_connect_transactions', 'list_custom_fields', 'list_daily_rebates', 'list_disputes', 'list_fees', 'list_gl_codes', 'list_manual_transactions', 'list_receipts', 'list_repayments', 'list_statement_payments', 'list_tax_mappings', 'list_transactions', 'manage_custom_field_options', 'manage_gl_code_exclusions', 'manage_gl_codes', 'manage_tax_mappings', 'update_gl_code_settings', 'update_transactions']::text[]),
    ('notion', ARRAY['append_blocks', 'create_comment', 'create_page', 'delete_block', 'get_block_children', 'get_database', 'get_page', 'list_comments', 'list_users', 'query_database', 'search', 'update_block', 'update_page']::text[]),
    ('outlook-calendar', ARRAY['create_event', 'delete_event', 'get_event', 'list_calendars', 'list_default_events', 'list_events', 'respond_event', 'update_event']::text[]),
    ('outlook-mail', ARRAY['create_draft', 'delete_message', 'forward_message', 'get_message', 'list_folder_messages', 'list_folders', 'list_messages', 'move_message', 'reply_message', 'send_mail', 'update_message']::text[]),
    ('posthog', ARRAY['create_annotation', 'create_dashboard', 'create_feature_flag', 'create_insight', 'get_current_user', 'get_insight', 'get_project', 'list_annotations', 'list_cohorts', 'list_dashboards', 'list_definitions', 'list_error_issues', 'list_events', 'list_experiments', 'list_feature_flags', 'list_insights', 'list_persons', 'list_projects', 'list_session_recordings', 'list_surveys', 'run_query', 'update_dashboard', 'update_feature_flag', 'update_insight']::text[]),
    ('pylon', ARRAY['create_account', 'create_account_activity', 'create_account_notebook_note', 'create_article', 'create_attachment', 'create_collection', 'create_contact', 'create_custom_object', 'create_feature_request', 'create_issue', 'create_issue_ai_response', 'create_issue_note', 'create_issue_thread', 'create_milestone', 'create_project', 'create_route_redirect', 'create_task', 'create_team', 'delete_account', 'delete_article', 'delete_call_recording', 'delete_collection', 'delete_contact', 'delete_custom_object', 'delete_email_suppression', 'delete_feature_request', 'delete_issue', 'delete_message', 'delete_milestone', 'delete_project', 'delete_task', 'draft_issue_reply', 'get_account', 'get_account_activities', 'get_account_notebook_notes', 'get_account_relationships', 'get_article', 'get_call_recording', 'get_collection', 'get_contact', 'get_custom_field', 'get_custom_object', 'get_feature_request', 'get_issue', 'get_issue_followers', 'get_issue_messages', 'get_issue_threads', 'get_issue_voice_calls', 'get_knowledge_base', 'get_knowledge_base_theme', 'get_macro', 'get_me', 'get_milestone', 'get_project', 'get_survey', 'get_survey_responses', 'get_tag', 'get_task', 'get_task_comments', 'get_team', 'get_ticket_form', 'get_training_data', 'get_user', 'link_external_issue', 'link_feature_request_evidence', 'link_task_issue', 'list_accounts', 'list_activity_types', 'list_article_feedback', 'list_articles', 'list_audit_logs', 'list_collections', 'list_contacts', 'list_custom_fields', 'list_custom_objects', 'list_email_suppressions', 'list_issue_statuses', 'list_issues', 'list_knowledge_bases', 'list_macro_groups', 'list_macros', 'list_surveys', 'list_tags', 'list_tasks', 'list_teams', 'list_ticket_forms', 'list_training_data', 'list_user_roles', 'list_users', 'manage_account_relationships', 'manage_custom_fields', 'manage_issue_followers', 'manage_issue_groups', 'manage_knowledge_base_theme', 'manage_macros', 'manage_tags', 'manage_task_comments', 'manage_training_data', 'merge_accounts', 'merge_feature_requests', 'redact_message', 'reply_to_issue', 'request_article_review', 'search_accounts', 'search_audit_logs', 'search_call_recordings', 'search_contacts', 'search_custom_objects', 'search_feature_requests', 'search_issues', 'search_milestones', 'search_projects', 'search_surveys', 'search_tasks', 'search_users', 'set_feature_request_portal_visibility', 'snooze_issue', 'submit_ticket_form', 'update_account', 'update_accounts', 'update_article', 'update_call_recording', 'update_collection', 'update_contact', 'update_custom_objects', 'update_feature_request', 'update_issue', 'update_milestone', 'update_project', 'update_task', 'update_team', 'update_user']::text[]),
    ('resend', ARRAY['create_batch', 'get_email', 'list_emails', 'send_email']::text[]),
    ('salesforce', ARRAY['create_record', 'delete_record', 'describe_object', 'get_record', 'list_objects', 'list_resources', 'list_versions', 'query', 'query_all', 'query_all_more', 'query_more', 'search', 'update_record']::text[]),
    ('sentry', ARRAY['create_deploy', 'create_release', 'delete_issue', 'get_issue', 'get_organization', 'get_project', 'get_user', 'list_issue_events', 'list_issues', 'list_members', 'list_organizations', 'list_projects', 'list_teams', 'update_issue']::text[]),
    ('snowflake', ARRAY['databases_get', 'databases_list', 'statements_cancel', 'statements_get', 'statements_submit', 'warehouses_list']::text[]),
    ('stripe', ARRAY['cancel_payment_intent', 'cancel_subscription', 'create_charge', 'create_customer', 'create_invoice', 'create_payment_intent', 'create_payout', 'create_price', 'create_product', 'create_refund', 'create_subscription', 'delete_customer', 'finalize_invoice', 'get_account', 'get_balance', 'get_customer', 'list_balance_transactions', 'list_charges', 'list_customers', 'list_disputes', 'list_events', 'list_invoices', 'list_payment_intents', 'list_payouts', 'list_prices', 'list_products', 'list_refunds', 'list_subscriptions', 'update_customer', 'update_subscription']::text[]),
    ('supabase', ARRAY['create_function', 'create_project', 'create_secrets', 'delete_function', 'get_auth_config', 'get_database_config', 'get_postgrest_config', 'get_project', 'list_functions', 'list_organizations', 'list_projects', 'list_secrets', 'list_storage_buckets', 'run_query', 'update_auth_config', 'update_function']::text[]),
    ('timeless', ARRAY['cancel_bot', 'get_document', 'get_notetaker_automation', 'get_recording', 'get_transcript', 'list_meeting_permissions', 'list_meetings', 'list_rooms', 'list_upcoming_meetings', 'list_webhooks', 'manage_webhooks', 'mcp_access', 'revoke_meeting_permission', 'schedule_bot', 'send_bot_to_link', 'set_meeting_permission', 'set_notetaker_automation', 'upload_media']::text[]),
    ('todoist', ARRAY['close_task', 'create_task', 'delete_task', 'get_task', 'list_projects', 'list_tasks', 'update_task']::text[]),
    ('trello', ARRAY['create_board', 'create_card', 'create_list', 'delete_card', 'get_board', 'get_card', 'get_cards', 'get_lists', 'list_boards', 'update_card']::text[]),
    ('vercel', ARRAY['add_domain', 'create_deployment', 'create_env_var', 'delete_env_var', 'get_deployment', 'get_project', 'get_user', 'list_deployments', 'list_domains', 'list_env_vars', 'list_projects', 'list_teams', 'remove_domain', 'update_env_var']::text[]),
    ('vertex-ai', ARRAY['generate_content', 'get_model', 'list_models', 'predict']::text[]),
    ('webflow', ARRAY['create_collection', 'create_collection_field', 'create_items', 'delete_asset', 'delete_collection', 'delete_form_submission', 'delete_items', 'delete_site_config', 'get_asset', 'get_authorized_user', 'get_collection', 'get_component', 'get_form', 'get_form_submission', 'get_item', 'get_page', 'get_robots_txt', 'get_site', 'get_site_activity', 'list_assets', 'list_collections', 'list_comments', 'list_components', 'list_form_submissions', 'list_forms', 'list_items', 'list_pages', 'list_sites', 'publish_items', 'publish_site', 'set_well_known_file', 'update_asset', 'update_collection', 'update_component', 'update_form_submission', 'update_items', 'update_page_content', 'update_page_settings', 'update_robots_txt', 'upload_asset']::text[]),
    ('x', ARRAY['block_user', 'create_bookmark', 'create_list', 'create_tweet', 'delete_bookmark', 'delete_tweet', 'follow', 'get_me', 'get_mentions', 'get_timeline', 'get_tweet', 'get_user', 'hide_reply', 'like_tweet', 'list_blocks', 'list_bookmarks', 'list_dm_events', 'list_followers', 'list_following', 'list_liked_tweets', 'list_lists', 'list_mutes', 'mute_user', 'retweet', 'search_tweets', 'send_dm', 'unfollow', 'unlike_tweet', 'upload_media']::text[]),
    ('youtube', ARRAY['delete_video', 'insert_comment', 'insert_video', 'list_channels', 'list_playlists', 'list_videos', 'search', 'update_video']::text[]),
    ('zoho-crm', ARRAY['create_account', 'create_contact', 'create_deal', 'create_lead', 'create_task', 'delete_account', 'delete_contact', 'delete_deal', 'delete_lead', 'delete_task', 'get_account', 'get_contact', 'get_deal', 'get_lead', 'get_org', 'get_settings', 'get_task', 'list_accounts', 'list_contacts', 'list_deals', 'list_leads', 'list_tasks', 'list_users', 'search_records', 'update_account', 'update_contact', 'update_deal', 'update_lead', 'update_task']::text[]),
    ('zoom', ARRAY['create_meeting', 'delete_meeting', 'get_meeting', 'get_recording_files', 'get_user', 'list_meetings', 'list_recordings', 'update_meeting']::text[])

),
full_grant AS MATERIALIZED (
  SELECT
    r."id",
    r."scope",
    r."workspace_id",
    r."organization_id",
    r."status",
    r."generation",
    r."priority",
    r."name",
    r."conditions",
    r."logical_id",
    r."created_by_user_id",
    i."agent_id",
    t."id" AS "target_id",
    t."app_connection_id",
    c."tools",
    gen_random_uuid()::text AS "new_id"
  FROM "policy_rules_v2" r
  JOIN "policy_rule_identities" i ON i."rule_id" = r."id"
  JOIN "policy_rule_targets" t ON t."rule_id" = r."id"
  JOIN "app_connections" ac ON ac."id" = t."app_connection_id"
  JOIN catalog c ON c."provider" = ac."provider"
  WHERE r."source" = 'grant'
    AND r."enabled" = true
    AND r."action" = 'allow'
    AND r."require_approval" = false
    AND r."is_default" = false
    AND i."agent_id" IS NOT NULL
    AND t."kind" = 'connection'
    AND cardinality(t."app_tools") = 0
    AND COALESCE(t."method", '') = ''
    AND NOT EXISTS (
      SELECT 1
      FROM "policy_rules_v2" s
      JOIN "policy_rule_identities" si ON si."rule_id" = s."id"
      JOIN "policy_rule_targets" st ON st."rule_id" = s."id"
      WHERE s."id" <> r."id"
        AND s."source" = 'grant'
        AND s."status" = r."status"
        AND s."generation" = r."generation"
        AND s."scope" = r."scope"
        AND s."workspace_id" IS NOT DISTINCT FROM r."workspace_id"
        AND s."organization_id" IS NOT DISTINCT FROM r."organization_id"
        AND si."agent_id" = i."agent_id"
        AND st."app_connection_id" = t."app_connection_id"
    )
),
affected AS (
  SELECT DISTINCT "scope", "workspace_id", "organization_id", "status", "generation"
  FROM full_grant
),
renumbered AS (
  UPDATE "policy_rules_v2" p
  SET "priority" = p."priority" * 2,
      "name" = CASE
        WHEN p."id" IN (SELECT "id" FROM full_grant) THEN p."name" || ': allowed'
        ELSE p."name"
      END,
      "updated_at" = CASE
        WHEN p."id" IN (SELECT "id" FROM full_grant) THEN CURRENT_TIMESTAMP
        ELSE p."updated_at"
      END
  FROM affected a
  WHERE p."scope" = a."scope"
    AND p."workspace_id" IS NOT DISTINCT FROM a."workspace_id"
    AND p."organization_id" IS NOT DISTINCT FROM a."organization_id"
    AND p."status" = a."status"
    AND p."generation" = a."generation"
  RETURNING p."id"
),
narrowed AS (
  UPDATE "policy_rule_targets" t
  SET "app_tools" = fg."tools"
  FROM full_grant fg
  WHERE t."id" = fg."target_id"
  RETURNING t."id"
),
terminal AS (
  INSERT INTO "policy_rules_v2" (
    "id", "scope", "organization_id", "workspace_id", "status", "generation",
    "priority", "enabled", "is_default", "logical_id", "source", "name",
    "action", "require_approval", "conditions", "created_by_user_id",
    "created_at", "updated_at"
  )
  SELECT
    fg."new_id", fg."scope", fg."organization_id", fg."workspace_id",
    fg."status", fg."generation", fg."priority" * 2 + 1, true, false,
    md5(fg."logical_id" || ':everything-else')::uuid::text, 'grant',
    fg."name" || ': everything else', 'allow', true, fg."conditions",
    fg."created_by_user_id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM full_grant fg
  RETURNING "id"
),
terminal_identity AS (
  INSERT INTO "policy_rule_identities" ("id", "rule_id", "agent_id")
  SELECT gen_random_uuid()::text, fg."new_id", fg."agent_id"
  FROM full_grant fg
  RETURNING "id"
)
INSERT INTO "policy_rule_targets" ("id", "rule_id", "kind", "app_connection_id", "app_tools")
SELECT gen_random_uuid()::text, fg."new_id", 'connection', fg."app_connection_id", ARRAY[]::text[]
FROM full_grant fg;
