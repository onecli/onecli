-- Vocabulary rename, zero data movement (every statement is a pure RENAME):
--   Grant    = standing permission            (agent_reach_grants)
--   Approval = one-shot decision              (action_approvals)
--   Card     = a posted mirror of a decision owned elsewhere
--
-- channel_approval_prompts was a card ledger misnamed as an approval: the
-- decision it mirrors lives in the GATEWAY; the row only tracks the posted
-- card (claim dedupe, update handle, re-arm deadline). prompt_refs on the
-- two decision tables carried the same stale word for their posted cards.

ALTER TABLE "channel_approval_prompts" RENAME TO "tool_approval_cards";
ALTER INDEX "channel_approval_prompts_pkey" RENAME TO "tool_approval_cards_pkey";
ALTER INDEX "channel_approval_prompts_approval_id_key" RENAME TO "tool_approval_cards_approval_id_key";
ALTER TABLE "tool_approval_cards" RENAME CONSTRAINT "channel_approval_prompts_agent_channel_id_fkey" TO "tool_approval_cards_agent_channel_id_fkey";

ALTER TABLE "action_approvals" RENAME COLUMN "prompt_refs" TO "card_refs";
ALTER TABLE "agent_reach_grants" RENAME COLUMN "prompt_refs" TO "card_refs";
