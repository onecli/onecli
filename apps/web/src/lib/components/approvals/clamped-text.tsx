"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@onecli/ui/lib/utils";
import type { ApprovalDetail } from "@/lib/api/approvals";
import { ApprovalLink } from "./approval-link";

/**
 * A prose value (an email body, a description) with its line breaks kept,
 * clamped to `lines` with an in-place Show more / Show less. The toggle only
 * appears when the clamp actually hides text.
 */
export const ClampedText = ({
  detail,
  lines = 4,
  className,
}: {
  detail: ApprovalDetail;
  lines?: 4 | 6;
  className?: string;
}) => {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [detail.value, expanded]);

  return (
    <div className={className}>
      <div
        ref={ref}
        className={cn(
          "break-words whitespace-pre-wrap",
          // Literal classes so Tailwind keeps both.
          !expanded && (lines === 6 ? "line-clamp-6" : "line-clamp-4"),
        )}
      >
        <ApprovalLink href={detail.url}>{detail.value}</ApprovalLink>
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-1 rounded-sm text-xs font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
};
