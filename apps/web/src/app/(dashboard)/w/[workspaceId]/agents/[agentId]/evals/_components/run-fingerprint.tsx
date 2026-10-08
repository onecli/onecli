import type { EvalRunDetail } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";

/**
 * The run's configuration fingerprint and what it can and cannot tell you,
 * folded away: it matters when an answer changed, not on every glance.
 */
export const RunFingerprint = ({ run }: { run: EvalRunDetail }) => {
  const changed =
    run.previous !== null && run.previous.configVersion !== run.configVersion;
  return (
    <details className="text-muted-foreground border-t px-4 py-3 text-xs">
      <summary className="hover:text-foreground w-fit cursor-pointer rounded-sm">
        Run details
      </summary>
      <div className="mt-2 max-w-prose space-y-2">
        <p>
          Started{" "}
          <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time>
          {". Configuration "}
          <code translate="no" className="text-foreground">
            {run.configVersion}
          </code>
          {changed && ", changed since the previous run"}.
        </p>
        <p>
          The configuration covers the instructions, model, effort, enabled
          skills and granted rules. It does not cover memory, rule details or
          the data the agent reads, so an answer can change while it stays the
          same. Look at the run&apos;s steps before editing the test or the
          instructions.
        </p>
      </div>
    </details>
  );
};
