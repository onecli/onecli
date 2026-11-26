import type { Nodes, Parents, Root } from "mdast";
import { visit } from "unist-util-visit";
import { blockDirection, messageDirection } from "./text-direction";

/**
 * Hebrew/Arabic answers render right-to-left. A remark plugin (like
 * remark-plain-dashes) rather than per-element React wrappers: the mdast
 * tree already separates prose from everything that must never vote (code,
 * inline code and link URLs are their own node types), and `hProperties` is
 * the sanctioned way to put an attribute on the element a node becomes -
 * react-markdown then hands `dir` to the `p` / `ul` / `h2` / `td` component
 * like any other prop.
 *
 * The message's direction (`messageDirection` over all its prose) is the
 * base; each block then refines its own from its text, so an English-only
 * line inside a Hebrew answer stays LTR while a mixed line stays on the
 * message's side. Containers decide for what they hold: direction lands on
 * the LIST (never the item), so every marker of one list sits on the same
 * side even when one bullet is all English; on the QUOTE, so its bar and
 * its text agree; on the TABLE, so its columns flip as one, with each cell
 * then aligning its own content. A paragraph or heading votes only at the
 * top level - inside a list or quote it follows the container. Code is
 * always LTR whatever it contains; ChatMarkdown pins that on the element.
 *
 * SECURITY: the only output is a `dir` attribute from a fixed two-value
 * union. Nothing about how the untrusted text is parsed changes, and no text
 * is interpolated into an attribute.
 */

/** Which nodes carry a `dir` of their own (see above). */
const votes = (node: Nodes, parent: Parents | undefined): boolean => {
  switch (node.type) {
    case "list":
    case "blockquote":
    case "table":
    case "tableCell":
      return true;
    case "paragraph":
    case "heading":
      return parent?.type === "root";
    default:
      return false;
  }
};

/**
 * The prose of a subtree - text nodes only. Code, inline code and link URLs
 * are other node types, so they never vote; a link's TEXT still does.
 */
const proseOf = (node: Nodes): string => {
  let out = "";
  visit(node, "text", (text) => {
    out += `${text.value} `;
  });
  return out;
};

export const remarkTextDirection = () => (tree: Root) => {
  const base = messageDirection(proseOf(tree));
  visit(tree, (node, _index, parent) => {
    if (!votes(node, parent)) return;
    node.data = {
      ...node.data,
      hProperties: {
        ...node.data?.hProperties,
        dir: blockDirection(proseOf(node), base),
      },
    };
  });
};
