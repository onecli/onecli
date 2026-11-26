"use client";

import { memo } from "react";
import {
  prettyJson,
  tokenizeJson,
  type JsonTokenKind,
} from "@/lib/chat/tool-display";

/**
 * A tool call's arguments, labelled "Request": pretty-printed and colored
 * when they are JSON, shown exactly as sent otherwise.
 *
 * SECURITY: the arguments are UNTRUSTED model text. Every token renders as
 * a text node inside a <span>; nothing is interpreted as HTML or markdown.
 */

const TOKEN_CLASS: Record<JsonTokenKind, string | undefined> = {
  key: "text-rose-700 dark:text-rose-400",
  string: "text-emerald-700 dark:text-emerald-400",
  number: "text-sky-700 dark:text-sky-400",
  literal: "text-violet-700 dark:text-violet-400",
  punct: undefined,
  space: undefined,
};

export const ToolInput = memo(({ text }: { text: string }) => {
  const input = prettyJson(text);
  return (
    <>
      <p className="text-muted-foreground mt-1 text-[11px] font-medium">
        Request
      </p>
      <pre
        translate="no"
        className="bg-muted/60 text-foreground/90 mt-1 mb-2 max-h-72 overflow-auto rounded-md p-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
      >
        {input.json
          ? tokenizeJson(input.text).map((token, index) => {
              const className = TOKEN_CLASS[token.kind];
              return className ? (
                <span key={index} className={className}>
                  {token.text}
                </span>
              ) : (
                token.text
              );
            })
          : input.text}
      </pre>
    </>
  );
});
ToolInput.displayName = "ToolInput";
