/**
 * OSS default "Agent group" slot in the create-agent dialog — OSS has no
 * agent groups, so the field renders nothing and the post-create assignment
 * is a no-op.
 *
 * Cloud aliases this module to `@/ee/groups/agent-group-field` via turbopack
 * `resolveAlias` in `next.config.js`: the EE override renders an optional
 * agent-group picker (admins only — the directory read is admin-gated and
 * the field hides itself when the query fails) and assigns the just-created
 * agent to the chosen group.
 */

export interface AgentGroupFieldProps {
  value: string | null;
  onChange: (groupId: string | null) => void;
}

export const AgentGroupField = ({}: AgentGroupFieldProps) => null;

export const assignAgentToGroup = async (
  agentId: string,
  groupId: string,
): Promise<void> => {
  void agentId;
  void groupId;
};
