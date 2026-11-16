"use client";

import { memo, type ReactNode } from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  type AnimateOptions,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { harden } from "rehype-harden";
import remarkGfm from "remark-gfm";
import { cn } from "@onecli/ui/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { isCardConnectLink } from "@/lib/chat/connect-links";
import { remarkPlainDashes } from "@/lib/markdown/remark-plain-dashes";
import { remarkTextDirection } from "@/lib/markdown/remark-text-direction";
import { safeUrlTransform } from "@/lib/markdown/safe-url";
import { messageDirection } from "@/lib/markdown/text-direction";
import { CodeBlock } from "./code-block";

/**
 * The transcript's markdown renderer, for the agent's answer from its first
 * streamed word to the stored record: one surface, so a reply that settles
 * never swaps element, size or color under the reader.
 *
 * What it renders is UNTRUSTED model output: anything that turns it
 * into live markup makes prompt injection into stored XSS against whoever
 * reads the conversation. The posture, guarded by chat-markdown.test.tsx, is
 * the same as the react-markdown renderer this replaced, never wider:
 *
 * - NO raw HTML, ever. The rehype list is OURS and replaces the library's
 *   default, which parses raw HTML (`rehype-raw`). Without it a `<script>` in
 *   model output is escaped text.
 * - The sanitize step (GitHub's schema) still runs, then `rehype-harden`
 *   restricted to http(s)/mailto with no `data:` images.
 * - Our own URL gate (`safeUrlTransform`) is the last word on every href and
 *   src, independent of either library's defaults.
 * - The library's interactive extras are off: no link-safety modal (our `a`
 *   below is the link), no code/table/diagram controls, no image wrapper
 *   chrome. Every element this renders comes from our components map.
 * - Links open in a new tab with `rel="noopener noreferrer"`.
 * - A half-written link (`[docs](https://exa` mid-stream) renders as its
 *   text, never as a link to a placeholder or a truncated address.
 *
 * Every block also carries a `dir` (remark-text-direction), so a Hebrew or
 * Arabic answer reads right-to-left block by block, while code is pinned LTR.
 *
 * STREAMING (`streaming`): the text is a draft still being written. The
 * library completes unterminated syntax (an open `**` renders bold, an open
 * fence renders as code) and fades each newly mounted word in. A settled
 * answer renders with no animation wrappers at all.
 */

/**
 * The reveal: each newly mounted word fades in over half a second, the
 * "ink still drying" edge of the text. Long enough that a batch of words
 * arriving at once reads as one soft motion, short enough that the newest
 * words are legible almost at once. Turned off under reduced motion by the
 * keyframes' own media query (packages/ui globals.css).
 */
const REVEAL: AnimateOptions = {
  animation: "fadeIn",
  duration: 500,
  easing: "ease-out",
  sep: "word",
  // The words arrive a few at a time already (useSmoothText paces them),
  // so the library's own stagger only spaces a handful per frame.
  stagger: 16,
  maxBacklogMs: 120,
};

/** The plugin shape the renderer takes (unified's `Pluggable`, read off its
 *  own props so we never depend on unified directly). */
type Pluggable = NonNullable<StreamdownProps["rehypePlugins"]>[number];

/**
 * OUR rehype list (it replaces the library's, see above): the library's own
 * sanitize step (GitHub's schema), then `rehype-harden` (the same version
 * the library pins, imported directly so its options are typed).
 */
const rehypePlugins: Pluggable[] = [
  defaultRehypePlugins.sanitize!,
  [
    harden,
    {
      allowedProtocols: ["http", "https", "mailto"],
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: ["*"],
      allowDataImages: false,
    },
  ],
];

/** Stable identity: an inline array would re-run the library's memo work on
 *  every render. Direction runs last: it votes on the prose the others leave. */
const remarkPlugins: Pluggable[] = [
  remarkGfm,
  remarkPlainDashes,
  remarkTextDirection,
];

/** The library's in-progress link placeholder, should one ever reach us. */
const INCOMPLETE_LINK = "streamdown:incomplete-link";

const MarkdownLink = ({
  children,
  href,
  title,
}: {
  children?: ReactNode;
  href?: string;
  title?: string;
}) =>
  // No address (gated away, or still being written): the words, unlinked.
  !href || href === INCOMPLETE_LINK ? (
    <>{children}</>
  ) : (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      className="decoration-current/30 hover:decoration-current/70 underline decoration-1 underline-offset-[3px] transition-colors [overflow-wrap:anywhere]"
    >
      {children}
    </a>
  );

/**
 * The typography of an answer. Body copy is 15px on a 1.65 line, headings a
 * short tight scale above it, and blocks spaced by rhythm (0.75em) rather
 * than fixed gaps, so a dense list and a lone paragraph read alike. Explicit
 * props only: spreading the renderer's extras would leak its `node` object
 * onto the DOM.
 */
const components: Components = {
  a: ({ children, href, title }) => (
    <MarkdownLink href={href} title={title}>
      {children}
    </MarkdownLink>
  ),
  p: ({ children, dir }) => (
    <p dir={dir} className="my-3 text-pretty first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  ul: ({ children, dir }) => (
    <ul
      dir={dir}
      className="marker:text-muted-foreground/70 my-3 list-disc space-y-1.5 ps-6 first:mt-0 last:mb-0 [&_ol]:my-1.5 [&_ul]:my-1.5"
    >
      {children}
    </ul>
  ),
  ol: ({ children, dir }) => (
    <ol
      dir={dir}
      className="marker:text-muted-foreground my-3 list-decimal space-y-1.5 ps-6 first:mt-0 last:mb-0 marker:tabular-nums [&_ol]:my-1.5 [&_ul]:my-1.5"
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="ps-0.5 [&>p]:my-1.5">{children}</li>,
  code: ({ children, className, ...props }) =>
    // The renderer marks fenced code with `data-block`; inline code has none.
    "data-block" in props ? (
      <CodeBlock className={className}>{children}</CodeBlock>
    ) : (
      <code
        dir="ltr"
        className="bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.875em]"
      >
        {children}
      </code>
    ),
  blockquote: ({ children, dir }) => (
    <blockquote
      dir={dir}
      className="border-border text-muted-foreground my-3 border-s-2 ps-4 first:mt-0 last:mb-0"
    >
      {children}
    </blockquote>
  ),
  h1: ({ children, dir }) => (
    <h1
      dir={dir}
      className="mt-6 mb-2 text-xl font-semibold tracking-tight text-balance first:mt-0"
    >
      {children}
    </h1>
  ),
  h2: ({ children, dir }) => (
    <h2
      dir={dir}
      className="mt-5 mb-2 text-[1.0625rem] font-semibold tracking-tight text-balance first:mt-0"
    >
      {children}
    </h2>
  ),
  h3: ({ children, dir }) => (
    <h3
      dir={dir}
      className="mt-4 mb-1.5 text-[0.9375rem] font-semibold text-balance first:mt-0"
    >
      {children}
    </h3>
  ),
  h4: ({ children, dir }) => (
    <h4
      dir={dir}
      className="mt-4 mb-1.5 text-[0.9375rem] font-medium first:mt-0"
    >
      {children}
    </h4>
  ),
  table: ({ children, dir }) => (
    <div className="border-border my-4 overflow-x-auto rounded-lg border first:mt-0 last:mb-0">
      <table
        dir={dir}
        className="w-full border-collapse text-sm tabular-nums [&_tr:last-child>td]:border-b-0"
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  th: ({ children, dir }) => (
    <th
      dir={dir}
      className="border-border border-b px-3 py-2 text-start font-medium"
    >
      {children}
    </th>
  ),
  td: ({ children, dir }) => (
    <td dir={dir} className="border-border/70 border-b px-3 py-2 align-top">
      {children}
    </td>
  ),
  hr: () => <hr className="border-border my-6" />,
  // Plain, unwrapped: the library's image chrome (a download control) is
  // not ours to offer. Its `src` already passed sanitize, harden and our
  // URL gate.
  img: ({ src, alt, title }) =>
    typeof src === "string" && src ? (
      // eslint-disable-next-line @next/next/no-img-element -- untrusted, arbitrary-origin markdown image; next/image would proxy it
      <img
        src={src}
        alt={alt ?? ""}
        title={title}
        className="my-3 max-w-full rounded-lg"
      />
    ) : null,
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
 * Memoized on the props: the thread re-renders on every stream read, and
 * without this every settled turn would re-parse many times a second
 * instead of only the one still streaming. While streaming, the library
 * splits the text into blocks and re-parses only the last one.
 */
export const ChatMarkdown = memo(
  ({
    text,
    suppressConnectLinks = false,
    streaming = false,
    draft = false,
    className,
  }: {
    text: string;
    /** Only the chat thread sets this — the surface that renders the connect
     * card as the replacement call to action. */
    suppressConnectLinks?: boolean;
    /** New words are arriving: complete open syntax and fade them in. Off
     * for every settled answer. */
    streaming?: boolean;
    /** The text is a draft, not the final answer: a "still writing" dot
     * follows its last word. */
    draft?: boolean;
    className?: string;
  }) => {
    // No per-word fade under reduced motion: not even its wrappers.
    const reducedMotion = usePrefersReducedMotion();
    const fade = streaming && !reducedMotion;
    return (
      // The root's `dir` is what flips list markers, indents and table
      // columns; the blocks inside refine their own.
      <div
        dir={messageDirection(text)}
        data-draft={draft || undefined}
        className={cn(
          // At least one line tall: a reply whose first word is still being
          // held back takes the caption's place at the same height, instead
          // of collapsing to nothing for a frame or two.
          "min-h-[1lh] min-w-0 text-[0.9375rem] leading-[1.65] break-words",
          className,
        )}
      >
        <Streamdown
          mode="streaming"
          isAnimating={fade}
          animated={fade ? REVEAL : false}
          parseIncompleteMarkdown={streaming}
          remend={{ linkMode: "text-only", images: false, katex: false }}
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarkPlugins}
          urlTransform={safeUrlTransform}
          linkSafety={{ enabled: false }}
          controls={false}
          lineNumbers={false}
          className="space-y-0"
          components={
            suppressConnectLinks ? connectSuppressingComponents : components
          }
        >
          {text}
        </Streamdown>
      </div>
    );
  },
);
ChatMarkdown.displayName = "ChatMarkdown";
