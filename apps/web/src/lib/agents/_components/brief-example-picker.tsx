"use client";

import { Button } from "@onecli/ui/components/button";
import { BRIEF_EXAMPLES } from "../brief-examples";

/**
 * Three briefs to start from, shown only while the field is empty.
 *
 * They disappear the moment there is anything to keep, because after that they
 * are a row of buttons that would silently overwrite what the user wrote.
 */
export const BriefExamplePicker = ({
  onPick,
}: {
  onPick: (text: string) => void;
}) => (
  <div
    role="group"
    aria-labelledby="brief-example-label"
    className="flex flex-wrap items-center gap-1.5"
  >
    <span id="brief-example-label" className="text-muted-foreground text-xs">
      Start from:
    </span>
    {BRIEF_EXAMPLES.map((example) => (
      <Button
        key={example.label}
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => onPick(example.text)}
      >
        {example.label}
      </Button>
    ))}
  </div>
);
