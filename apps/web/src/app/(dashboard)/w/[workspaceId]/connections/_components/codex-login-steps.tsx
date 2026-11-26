"use client";

import { CopyableCommand } from "./copyable-command";
import { StepNumber } from "./step-number";

/**
 * How to get a Codex (ChatGPT login) token file, as two short numbered steps
 * instead of one run-on sentence. Step 1's command is the copyable chip (the
 * visible text is exactly what lands on the clipboard); step 2 points at the
 * upload box below by name.
 */
export const CodexLoginSteps = () => (
  <ol className="text-muted-foreground space-y-1.5 text-xs">
    <li className="flex items-center gap-2">
      <StepNumber n={1} />
      <span>
        In your terminal, run{" "}
        <CopyableCommand
          command="codex login --device-auth"
          toastMessage="Copied. Run it in your terminal, then upload the auth.json it writes."
          className="font-semibold"
        />
      </span>
    </li>
    <li className="flex items-center gap-2">
      <StepNumber n={2} />
      <span>
        Upload the <code className="font-mono font-semibold">auth.json</code>{" "}
        file it creates (below)
      </span>
    </li>
  </ol>
);
