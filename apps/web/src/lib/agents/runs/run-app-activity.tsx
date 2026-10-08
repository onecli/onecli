import type { RunDetail } from "@/lib/api";
import { RunSection } from "./run-section";

/**
 * The gateway calls the agent made while the run was going. They are
 * matched by agent and time window, not by turn, so concurrent runs can
 * appear and absence proves nothing; request paths are never shown.
 */
export const RunAppActivity = ({ run }: { run: RunDetail }) => (
  <RunSection title="App activity">
    {run.appAttribution === "withheld" ? (
      <p className="text-muted-foreground text-sm">
        App activity is not available for this run. It is shown only to org
        admins, and only when the gateway log could be read in full. This does
        not mean no apps were called.
      </p>
    ) : run.appCalls.length === 0 ? (
      <p className="text-muted-foreground text-sm">
        No app calls were found while this run was going. Calls can still be
        missed.
      </p>
    ) : (
      <div className="divide-y rounded-md border text-xs">
        <p className="text-muted-foreground px-3 py-2">
          Matched by agent and time, not by run, so calls from other runs at the
          same time can appear here.
        </p>
        <ul>
          {run.appCalls.map((call, index) => (
            <li
              key={`${call.at}-${index}`}
              className="flex items-center gap-2 px-3 py-1.5"
            >
              <span className="w-20 shrink-0 truncate font-medium">
                {call.provider}
              </span>
              <code
                translate="no"
                className="text-muted-foreground min-w-0 flex-1 truncate font-mono"
              >
                {call.method} {call.host}
              </code>
              <span
                className={
                  call.status >= 400
                    ? "text-destructive tabular-nums"
                    : "text-muted-foreground tabular-nums"
                }
              >
                {call.status}
              </span>
              <span className="text-muted-foreground w-14 shrink-0 text-end tabular-nums">
                {call.latencyMs} ms
              </span>
            </li>
          ))}
        </ul>
      </div>
    )}
  </RunSection>
);
