"use client";

import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isCardConnectLink } from "@/lib/chat/connect-links";
import { remarkPlainDashes } from "@/lib/markdown/remark-plain-dashes";
import { remarkTextDirection } from "@/lib/markdown/remark-text-direction";
import { messageDirection } from "@/lib/markdown/text-direction";

// Stable array identity — an inline literal would defeat the memo below by
// changing on every parent render. Text direction runs last: it votes on the
// prose the other plugins leave behind.
const remarkPlugins = [remarkGfm, remarkPlainDashes, remarkTextDirection];

/**
 * The transcript's markdown renderer. What it renders is UNTRUSTED, DURABLE
 * model output (#783) — anything that turns it into live markup makes prompt
 * injection into stored XSS against whoever reads the conversation. The
 * safety posture, guarded by chat-markdown.test.tsx:
 *
 * - NO rehype plugins, ever. react-markdown without `rehype-raw` never parses
 *   raw HTML — a `<script>` in model output renders as escaped text.
 * - The default `urlTransform` stays: links/images keep an http(s)/mailto
 *   protocol allowlist, so `javascript:` hrefs die here.
 * - Links open in a new tab with `rel="noopener noreferrer"`.
 *
 * Every block also carries a `dir` (remark-text-direction), so a Hebrew or
 * Arabic answer reads right-to-left block by block. The block components
 * forward it and nothing else (a fixed two-value attribute, never text),
 * while code is pinned LTR whatever it contains.
 */
const MarkdownLink = ({
  children,
  href,
  title,
}: {
  children?: ReactNode;
  href?: string;
  title?: string;
}) => (
  <a
    href={href}
    title={title}
    target="_blank"
    rel="noopener noreferrer"
    className="text-foreground underline underline-offset-2 break-words hover:opacity-80"
  >
    {children}
  </a>
);

const components: Components = {
  // Explicit props only — spreading react-markdown's extras would leak its
  // `node` hast object onto the DOM element.
  a: ({ children, href, title }) => (
    <MarkdownLink href={href} title={title}>
      {children}
    </MarkdownLink>
  ),
  p: ({ children, dir }) => (
    <p dir={dir} className="my-2 leading-relaxed first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children, dir }) => (
    <ul dir={dir} className="my-2 list-disc space-y-1 ps-5">
      {children}
    </ul>
  ),
  ol: ({ children, dir }) => (
    <ol dir={dir} className="my-2 list-decimal space-y-1 ps-5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ children, className }) => (
    <code
      dir="ltr"
      className={`bg-muted rounded px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      dir="ltr"
      className="bg-muted my-2 overflow-x-auto rounded-lg p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0"
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, dir }) => (
    <blockquote
      dir={dir}
      className="border-border text-muted-foreground my-2 border-s-2 ps-3"
    >
      {children}
    </blockquote>
  ),
  h1: ({ children, dir }) => (
    <h1 dir={dir} className="mt-4 mb-2 text-base font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children, dir }) => (
    <h2 dir={dir} className="mt-4 mb-2 text-sm font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children, dir }) => (
    <h3 dir={dir} className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children, dir }) => (
    <h4 dir={dir} className="mt-3 mb-1.5 text-sm font-medium first:mt-0">
      {children}
    </h4>
  ),
  table: ({ children, dir }) => (
    <div className="my-2 overflow-x-auto">
      <table dir={dir} className="w-full border-collapse text-xs">
        {children}
      </table>
    </div>
  ),
  th: ({ children, dir }) => (
    <th
      dir={dir}
      className="border-border bg-muted border px-2 py-1 text-start font-medium"
    >
      {children}
    </th>
  ),
  td: ({ children, dir }) => (
    <td dir={dir} className="border-border border px-2 py-1">
      {children}
    </td>
  ),
  hr: () => <hr className="border-border my-4" />,
};

/** The chat-thread variant: a gateway "connect this app" URL vanishes from
 * the prose, because there the ConnectorSuggestions card below the answer is
 * the ONE call to action (link + card together read as a duplicate). The
 * predicate is exactly the card's (`isCardConnectLink`) — a link must never
 * be suppressed unless the card that replaces it will render. Opt-in per
 * consumer — the memory sheet renders the same markdown with no card, so its
 * connect links must stay ordinary (hardened) links. */
const connectSuppressingComponents: Components = {
  ...components,
  a: ({ children, href, title }) =>
    href && isCardConnectLink(href) ? null : (
      <MarkdownLink href={href} title={title}>
        {children}
      </MarkdownLink>
    ),
};

/**
 * Memoized on the props: react-markdown re-parses from scratch on
 * every render, and the thread re-renders on every stream read — without
 * this, a delta storm re-parses EVERY settled turn's markdown many times a
 * second instead of only the turn that changed.
 */
export const ChatMarkdown = memo(
  ({
    text,
    suppressConnectLinks = false,
  }: {
    text: string;
    /** Only the chat thread sets this — the surface that renders the connect
     * card as the replacement call to action. */
    suppressConnectLinks?: boolean;
  }) => (
    // The root's `dir` is what flips list markers, indents and table
    // columns; the blocks inside refine their own.
    <div dir={messageDirection(text)} className="min-w-0 text-sm break-words">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={
          suppressConnectLinks ? connectSuppressingComponents : components
        }
      >
        {text}
      </ReactMarkdown>
    </div>
  ),
);
ChatMarkdown.displayName = "ChatMarkdown";
