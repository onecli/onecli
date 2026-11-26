"use client";

import type { GenericInjection } from "./generic-injection";

/** One "Try an example" preset for the custom connection form. */
export interface CustomConnectionExample {
  name: string;
  hostPattern: string;
  injection: Partial<GenericInjection>;
}

/**
 * One real API per way the gateway can send a key, none of them a built-in
 * app (a custom connection on an app's host would take over that app's
 * requests). Shapes per each API's docs: Airtable takes a Bearer token, the
 * Google Maps web services a `key` URL parameter, the Telegram Bot API the
 * token in the path (`/bot<token>/METHOD`).
 */
const EXAMPLES: readonly CustomConnectionExample[] = [
  {
    name: "Airtable",
    hostPattern: "api.airtable.com",
    injection: { sentAs: "bearer" },
  },
  {
    name: "Google Maps",
    hostPattern: "maps.googleapis.com",
    injection: { sentAs: "param", paramName: "key" },
  },
  {
    name: "Telegram Bot",
    hostPattern: "api.telegram.org",
    injection: {
      sentAs: "path",
      pathMode: "template",
      pathTemplate: "/bot{value}",
    },
  },
];

const linkClassName =
  "text-xs text-green-600 underline underline-offset-2 transition-colors hover:text-green-500 dark:text-green-400 dark:hover:text-green-300 rounded-sm outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]";

export interface CustomConnectionExamplesProps {
  onPick: (example: CustomConnectionExample) => void;
}

/** "Try an example: Airtable | Google Maps | Telegram Bot". */
export const CustomConnectionExamples = ({
  onPick,
}: CustomConnectionExamplesProps) => (
  <div className="flex flex-wrap items-center gap-2 pt-1">
    <span className="text-muted-foreground text-xs">Try an example:</span>
    {EXAMPLES.map((example, i) => (
      <span key={example.name} className="flex items-center gap-2">
        {i > 0 && (
          <span aria-hidden className="text-muted-foreground text-xs">
            |
          </span>
        )}
        <button
          type="button"
          className={linkClassName}
          onClick={() => onPick(example)}
        >
          {example.name}
        </button>
      </span>
    ))}
  </div>
);
