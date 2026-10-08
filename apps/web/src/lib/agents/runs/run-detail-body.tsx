import { ToolGroup } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/chat/_components/tool-group";
import type { RunDetail } from "@/lib/api";
import type { ToolCall } from "@/lib/chat/transcript";
import { isActiveTurnStatus } from "@/lib/chat/turns";
import { RunAppActivity } from "./run-app-activity";
import { RunSection } from "./run-section";

/** A stored tool call in the chat's shape: no output yet means running. */
const toToolCall = (tool: RunDetail["tools"][number]): ToolCall => ({
  callId: tool.callId,
  name: tool.name,
  ...(tool.input !== null && { input: tool.input }),
  ...(tool.output !== null && { output: tool.output }),
  ...(tool.isError && { isError: true }),
});

/**
 * One run in full: the question, the steps the agent took (the chat's own
 * tool group), the apps it reached, and how it ended.
 *
 * SECURITY: every string is untrusted model or tool text and renders as
 * text; the answer is shown as plain text, never markdown.
 */
export const RunDetailBody = ({ run }: { run: RunDetail }) => {
  const active = isActiveTurnStatus(run.status);
  return (
    <div className="space-y-5 p-4">
      <RunSection title="Question">
        <p className="text-sm break-words whitespace-pre-wrap">
          {run.question}
        </p>
      </RunSection>

      {run.tools.length > 0 && (
        <RunSection title="Steps">
          <ToolGroup
            tools={run.tools.map(toToolCall)}
            turnEnded={!active}
            startedAt={run.startedAt ?? run.createdAt}
            defaultOpen
          />
        </RunSection>
      )}

      <RunAppActivity run={run} />

      <RunSection title="Answer">
        <p className="text-sm break-words whitespace-pre-wrap">
          {run.answer ?? (active ? "Still working…" : "No answer.")}
        </p>
        {run.error && (
          <p
            role="alert"
            className="text-destructive text-sm break-words whitespace-pre-wrap"
          >
            {run.error}
          </p>
        )}
      </RunSection>
    </div>
  );
};
