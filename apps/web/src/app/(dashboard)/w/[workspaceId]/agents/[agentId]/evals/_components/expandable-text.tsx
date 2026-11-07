"use client";

import { useState } from "react";
import { Button } from "@onecli/ui/components/button";

/** How much of a long answer shows before "Show more". */
const PREVIEW_CHARS = 280;

/** The first `max` UTF-16 units, never splitting a surrogate pair (emoji). */
const clip = (text: string, max: number) => {
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}…`;
};

/** Plain text with its line breaks kept, clipped with a Show more toggle. */
export const ExpandableText = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > PREVIEW_CHARS;
  return (
    <>
      <p className="break-words whitespace-pre-wrap">
        {long && !expanded ? clip(text, PREVIEW_CHARS) : text}
      </p>
      {long && (
        <Button
          size="xs"
          variant="link"
          className="h-auto px-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </>
  );
};
