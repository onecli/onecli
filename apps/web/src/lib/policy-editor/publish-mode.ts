import { policy } from "@/lib/api";
import type { PageScope } from "@/lib/api";

/**
 * The OSS publish-mode seam (step 9.5): IMMEDIATE APPLY. OSS's editor has no
 * staged-publish surface (§2.9 keeps preview/publish in OneCLI Cloud), so
 * every write publishes right away — matching the legacy OSS editor, where
 * every change was live on save. Chained inside the mutation, so the button's
 * pending state covers write + publish and the cache invalidation that follows
 * sees the published truth.
 *
 * If the publish half ever fails, the write IS staged in the draft; the next
 * successful write publishes the WHOLE draft (snapshot semantics), so the
 * state self-heals. The EE editions alias this file to
 * `@/ee/policy-editor/publish-mode` (a no-op — their publish is the explicit
 * staged Apply Changes flow).
 */
export const afterPolicyWrite = async (scope: PageScope): Promise<void> => {
  await policy.publish(scope);
};

/** The rule drawer's subtitle — OSS applies writes immediately (no draft). */
export const RULE_SHEET_DESCRIPTION =
  "Who this applies to, what it targets, and what happens. Changes apply immediately.";
