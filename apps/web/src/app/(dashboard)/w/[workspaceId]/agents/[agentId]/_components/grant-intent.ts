import type { ConnectionGrantInput } from "@onecli/api/validations/grants";
import type { ToolChoice } from "./tri-state-control";

/**
 * The tri-state tool grid → grant intent. Extracted from
 * `ManagePermissionsDialog` so the rule is unit-testable without mounting the
 * dialog: it decides how much access a save actually writes.
 *
 * Every tool on Allow IS the whole-app grant — the same shape the connect
 * picker writes — so it compiles to `full`: one allow row matching host-only,
 * with tools added to the catalog later arriving auto-allowed.
 *
 * This deliberately does NOT also require the grant to already be `full`.
 * Requiring that made the transition ONE-WAY: once a grant became `custom`,
 * returning every switch to Allow could never restore `full`, so the dialog
 * showed an all-Allow grid while saving a per-tool grant — visually identical
 * to full access, materially narrower in the engine, and dependent on every
 * catalog pattern being exhaustive to behave the same.
 */
export const grantIntentFromChoices = (
  toolIds: string[],
  choices: Record<string, ToolChoice>,
): ConnectionGrantInput => {
  const allAllow =
    toolIds.length > 0 && toolIds.every((id) => choices[id] === "allow");
  if (allAllow) return { access: "full" };
  return {
    access: "custom",
    allow: toolIds.filter((id) => choices[id] === "allow"),
    ask: toolIds.filter((id) => choices[id] === "ask"),
  };
};
