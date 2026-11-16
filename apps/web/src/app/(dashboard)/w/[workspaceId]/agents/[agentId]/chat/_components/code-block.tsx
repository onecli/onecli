"use client";

import { Check, Copy } from "lucide-react";
import { Children, isValidElement, type ReactNode } from "react";
import { cn } from "@onecli/ui/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/** `language-ts` → `ts`, from the fence's info string. Only the label: the
 *  class itself never reaches the DOM unchecked. */
const LANGUAGE = /(?:^|\s)language-([\w+#.-]{1,32})(?:\s|$)/;

/** The text of a code element's children, however the renderer split it. */
const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("");

/**
 * A fenced code block in an answer: a quiet bordered card with the language
 * on the left and a copy button on the right, the code itself scrolling
 * sideways rather than wrapping, so a long command stays one copyable line.
 *
 * No syntax highlighting, on purpose: it would mean shipping a highlighter
 * to every chat for the occasional snippet, and monochrome code reads fine
 * at this size. The copy button copies exactly the code text.
 *
 * SECURITY: the content is untrusted model output rendered as text inside
 * <pre><code>. The language label is matched against a strict pattern, never
 * echoed raw.
 */
export const CodeBlock = ({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) => {
  const { copied, copy } = useCopyToClipboard();
  const language = className?.match(LANGUAGE)?.[1];
  // A fence's text ends with the newline before its closing ```: copying
  // it would paste a stray blank line.
  const code = textOf(children).replace(/\n$/, "");

  return (
    <div
      dir="ltr"
      data-slot="code-block"
      className="border-border bg-muted/40 group/code my-4 overflow-hidden rounded-xl border first:mt-0 last:mb-0"
    >
      <div className="border-border/70 text-muted-foreground flex h-9 items-center justify-between border-b ps-3.5 pe-1.5 text-xs">
        <span className="font-mono lowercase" translate="no">
          {language ?? "code"}
        </span>
        <button
          type="button"
          onClick={() => void copy(code)}
          aria-label={copied ? "Copied" : "Copy code"}
          className={cn(
            "hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 inline-flex size-7 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-[3px]",
            copied && "text-foreground",
          )}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      <pre
        dir="ltr"
        className="overflow-x-auto px-3.5 py-3 font-mono text-[0.8125rem] leading-[1.6]"
      >
        <code translate="no">{code}</code>
      </pre>
    </div>
  );
};
