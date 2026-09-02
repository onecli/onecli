import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";

/**
 * House copy style: no em dashes in agent prose (the Slack adapter enforces
 * the same rule in apps/channel-adapter/src/slack/mrkdwn.ts, and static UI
 * copy is pinned by ui-copy-guard.test.ts). This is the web-transcript
 * counterpart: a remark plugin that rewrites em/en dashes to " - " in
 * markdown TEXT nodes only.
 *
 * Operating on the mdast tree (not the raw string) is what keeps it safe to
 * reuse anywhere: code blocks, inline code, and link URLs are different node
 * types, so a dash that is content — inside `code`, a fence, or a URL —
 * is never touched. Surrounding horizontal whitespace (spaces, tabs, NBSP
 * and narrow NBSP — typographic prose flanks dashes with those) collapses,
 * so "a — b" and "a—b" both come out as "a - b", and a dash RUN collapses
 * to one hyphen. Horizontal only — never \s: a newline matched here would
 * consume the break and join two lines (the Slack mrkdwn.ts pass applies
 * the same rule for the same reason). A dash at a node edge (after a link
 * or emphasis split the sentence into nodes) becomes " - " too, which
 * reads the same.
 */
export const remarkPlainDashes = () => (tree: Root) => {
  visit(tree, "text", (node: Text) => {
    if (!/[—–]/.test(node.value)) return;
    node.value = node.value.replace(
      /[ \t\u00a0\u202f]*[—–]+[ \t\u00a0\u202f]*/g,
      " - ",
    );
  });
};
