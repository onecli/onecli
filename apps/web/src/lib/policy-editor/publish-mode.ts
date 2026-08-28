import type { PageScope } from "@/lib/api";

/**
 * The publish-mode seam for the policy editor.
 *
 * ORG scope is STAGED: writes land in the draft and publishing is the explicit
 * reviewed Apply Changes flow (the staged chrome). Org is now the only scope
 * this editor serves — attach-model step 6 removed the workspace console, and
 * with it the workspace write-through arm that used to publish on every write.
 * Workspace-level publishing did not disappear: it moved server-side, into the
 * grants API's atomic write-then-publish transaction.
 */
export const afterPolicyWrite: (scope: PageScope) => Promise<void> = () =>
  // Staged by design — nothing to do after a write.
  Promise.resolve();

/** The rule drawer's subtitle. */
export const ruleSheetDescription: (scope: PageScope) => string = () =>
  "Who this applies to, what it targets, and what happens. Saved as a draft. Publish to enforce.";
