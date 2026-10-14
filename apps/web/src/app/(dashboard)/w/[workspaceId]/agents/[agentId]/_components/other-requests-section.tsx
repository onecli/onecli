"use client";

import { TriStateControl, type ToolChoice } from "./tri-state-control";
import type { OtherChoices } from "./grant-intent";

export interface OtherRequestsSectionProps {
  other: OtherChoices;
  /** `"block"` for a catalog that blocks unlisted requests by default (AWS). */
  unlisted: "block" | undefined;
  /** Every tool above is on Always allow. For a catalog that blocks unlisted
   * requests, that is the only state where these rows may be Always allow:
   * then the grant is full access, which covers both rows at once. */
  allToolsAllowed: boolean;
  readOnly: boolean;
  onChange: (next: OtherChoices) => void;
}

const ROWS = [
  {
    key: "otherReads",
    name: "Other reads",
    description: "Read requests (GET and HEAD)",
  },
  {
    key: "otherWrites",
    name: "Other writes",
    description: "Everything else: create, update, delete",
  },
] as const satisfies readonly {
  key: keyof OtherChoices;
  name: string;
  description: string;
}[];

const BLOCKED_ALLOW_WHY =
  "Set every tool above to Always allow first: this app's credential reaches every service, and some services run deletes sent as reads";

/**
 * The catch-all section, set apart from the tool sections on purpose: these
 * rows don't name a tool, they decide every request the app's tool list
 * doesn't describe (tools added later included). Boxed, explained, and with no
 * bulk dropdown, so it reads as a different kind of setting and the section
 * dropdowns above visibly don't reach it.
 *
 * A catalog that blocks unlisted requests (AWS) offers Always allow here only
 * as full access: every tool above on Always allow, and both rows together.
 * The API refuses it on a customized grant, because one AWS credential
 * reaches every service and many of them run a delete sent as a GET.
 */
export const OtherRequestsSection = ({
  other,
  unlisted,
  allToolsAllowed,
  readOnly,
  onChange,
}: OtherRequestsSectionProps) => {
  const closed = unlisted === "block";
  const isOptionDisabled = (value: ToolChoice) =>
    closed && value === "allow" && !allToolsAllowed
      ? { disabled: true, why: BLOCKED_ALLOW_WHY }
      : { disabled: false };
  // On a closed catalog, Always allow is full access, which covers both rows:
  // choosing it on one sets both, and leaving it on one leaves it on both.
  const select = (key: keyof OtherChoices, choice: ToolChoice) => {
    const next = { ...other, [key]: choice };
    if (closed && (choice === "allow" || other[key] === "allow")) {
      next.otherReads = choice;
      next.otherWrites = choice;
    }
    onChange(next);
  };

  return (
    <section
      aria-label="Not listed above"
      className="bg-muted/40 rounded-lg border border-dashed px-4 py-3"
    >
      <h3 className="text-sm font-medium">Not listed above</h3>
      <p className="text-muted-foreground mt-0.5 text-xs">
        Requests this app makes that aren&apos;t one of the tools above,
        including tools added later.
        {closed &&
          " This app's credential reaches every service, so these can be always allowed only as full access: every tool above on Always allow, and both rows together."}
      </p>
      <div className="mt-2 divide-y">
        {ROWS.map((row) => (
          <div
            key={row.key}
            className="flex items-start justify-between gap-4 py-2.5"
          >
            <div className="min-w-0">
              <span className="text-sm">{row.name}</span>
              <p className="text-muted-foreground mt-0.5 break-words text-xs">
                {row.description}
              </p>
            </div>
            <div
              className="-mt-1.5 shrink-0"
              role="group"
              aria-label={row.name}
            >
              <TriStateControl
                value={other[row.key]}
                onSelect={(choice: ToolChoice) => select(row.key, choice)}
                isOptionDisabled={isOptionDisabled}
                disabled={readOnly}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
