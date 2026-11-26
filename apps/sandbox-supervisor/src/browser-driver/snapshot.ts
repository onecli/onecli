/**
 * The compact page view the agent reads by default: every element it can
 * act on, one per line, with its ref. Built from Playwright's AI-mode aria
 * snapshot (the YAML-like tree `ariaSnapshot({ mode: "ai" })` prints), kept
 * as text so the parse is a line walk and nothing else. The tree is parsed
 * once per reply; the list, the refs, and the dialogs' controls are all
 * computed from that one parse.
 *
 * Why a filter and not the whole tree: a news front page is 8-9K tokens as
 * a full tree and about 1.2K as this list (measured in the agent image),
 * and an agent choosing a link never needs the paragraphs between them.
 * Headings stay in: they are how a person orients on a page, and they cost
 * a few lines.
 */

import type { ModalAction } from "./protocol";
import type { Element } from "./target";

/** Roles an agent acts on, plus headings for orientation. */
const KEPT_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "heading",
]);

/** The list stays readable: past this, the agent scrolls or asks for --full. */
export const MAX_LINES = 400;

/**
 * One tree line: `- role "name" [attr] [ref=e12] [cursor=pointer]: trailing`.
 * Nodes without a ref (text runs, `/url` children, options inside a closed
 * combobox) have no `[ref=…]` and are skipped. Frame-prefixed refs (`f1e2`:
 * an iframe, or the main frame after a navigation) are kept as-is: the
 * driver resolves them the same way.
 *
 * The tree is YAML, and a key YAML could misread (a name with `: ` in it,
 * a leading `-`, a trailing space) comes wrapped in single quotes with `'`
 * doubled: `- 'link "Documents: Police…" [ref=e61] [cursor=pointer]':`.
 * Observed live on a news front page; the unquoted regex missed every
 * such line, and the agent's click on its ref was refused as stale.
 */
const LINE =
  /^\s*-\s+(?<role>[a-z]+)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?<attrs>(?:\s+\[[^\]]*\])*)(?::\s*(?<rest>.*))?$/;
const QUOTED_KEY = /^(?<indent>\s*)-\s+'(?<key>(?:[^']|'')*)'(?<rest>:.*)?$/;
const REF = /\[ref=([a-z0-9]+)\]/;

/** One line of the tree, parsed. */
export interface SnapshotNode {
  indent: number;
  role: string;
  name: string;
  /** Null for the lines the generator gives no ref (a `text:` run, an option). */
  ref: string | null;
  /** Attributes worth a glance: disabled, checked, selected, level… */
  flags: string[];
}

/** An element the list prints: a node that has a ref, named as a person reads it. */
interface SnapshotLine extends Element {
  flags: string[];
}

/** Attribute brackets the list repeats; `cursor=pointer` and the ref are noise. */
const SHOWN_FLAGS =
  /^\[(disabled|checked|unchecked|selected|expanded|collapsed|pressed|required|readonly|active|level=\d+)\]$/;

/** The line with YAML's single-quote wrapping undone, if it had any. */
const unquoteKey = (line: string): string => {
  const q = QUOTED_KEY.exec(line);
  if (!q?.groups) return line;
  const key = (q.groups.key ?? "").replace(/''/g, "'");
  return `${q.groups.indent ?? ""}- ${key}${q.groups.rest ?? ""}`;
};

const parseLine = (raw: string): SnapshotNode | null => {
  const line = unquoteKey(raw);
  const m = LINE.exec(line);
  if (!m?.groups) return null;
  const attrs = m.groups.attrs ?? "";
  return {
    indent: line.length - line.trimStart().length,
    role: m.groups.role ?? "",
    name: m.groups.name?.replace(/\\(.)/g, "$1") ?? "",
    ref: REF.exec(attrs)?.[1] ?? null,
    flags: attrs
      .split(/(?=\[)/)
      .map((f) => f.trim())
      .filter((f) => SHOWN_FLAGS.test(f))
      .map((f) => f.slice(1, -1)),
  };
};

/** Every line of the tree the grammar recognizes, in tree order. */
export const parseSnapshot = (tree: string): SnapshotNode[] => {
  const nodes: SnapshotNode[] = [];
  for (const raw of tree.split("\n")) {
    const node = parseLine(raw);
    if (node) nodes.push(node);
  }
  return nodes;
};

/** Where the subtree under `nodes[i]` ends (exclusive). */
const subtreeEnd = (nodes: readonly SnapshotNode[], i: number): number => {
  const indent = nodes[i]?.indent ?? 0;
  let end = i + 1;
  while (end < nodes.length && (nodes[end]?.indent ?? 0) > indent) end += 1;
  return end;
};

/**
 * A node's name as a person reads it. A nameless link or button takes the
 * name of its first named descendant (an icon link is `link [ref=e18]` over
 * `img "Icon link"`).
 */
const readName = (nodes: readonly SnapshotNode[], i: number): string => {
  const node = nodes[i];
  if (!node) return "";
  if (node.name !== "" || (node.role !== "link" && node.role !== "button"))
    return node.name;
  const end = subtreeEnd(nodes, i);
  for (let j = i + 1; j < end; j += 1) {
    const name = nodes[j]?.name ?? "";
    if (name !== "") return name;
  }
  return "";
};

/**
 * Every node with a ref, in tree order, named as a person reads it: the
 * elements a verb can name, by ref or by the role and name its line shows.
 */
export const elementsOf = (nodes: readonly SnapshotNode[]): SnapshotLine[] => {
  const out: SnapshotLine[] = [];
  nodes.forEach((node, i) => {
    if (node.ref)
      out.push({
        ref: node.ref,
        role: node.role,
        name: readName(nodes, i),
        flags: node.flags,
      });
  });
  return out;
};

/**
 * The agent's default view: interactive elements and headings, one per
 * line. `first` are listed ahead of the rest: the open modal's, so its
 * fields and buttons sit under its modal line and are never the part the
 * line cap cuts (a modal is often the last thing in the document).
 */
export const compactSnapshot = (
  elements: readonly SnapshotLine[],
  first: ReadonlySet<string> = new Set(),
): string => {
  const kept = elements.filter(
    (l) => KEPT_ROLES.has(l.role) && (l.name !== "" || l.role !== "heading"),
  );
  if (first.size > 0)
    kept.sort((a, b) => Number(first.has(b.ref)) - Number(first.has(a.ref)));
  const lines = kept.slice(0, MAX_LINES).map(formatLine);
  if (kept.length > MAX_LINES) {
    lines.push(
      `… ${String(kept.length - MAX_LINES)} more elements: scroll, or snapshot --full`,
    );
  }
  return lines.join("\n");
};

const formatLine = (l: SnapshotLine): string => {
  const name = l.name === "" ? "" : ` "${l.name}"`;
  const flags = l.flags.length === 0 ? "" : ` [${l.flags.join(", ")}]`;
  return `${l.ref} ${l.role}${name}${flags}`;
};

/** The controls a dialog's line names; the element list has the rest. */
export const DIALOG_ACTIONS_MAX = 4;

/**
 * A dialog as the tree describes it: its ref, its accessible name, the
 * controls that answer it, and every ref inside it (what stays reachable
 * while it blocks the page). Whether it is open, and whether it blocks the
 * page, the tree cannot say (a side menu marked `role=dialog` prints
 * exactly like a blocking one); the page says, and `matchDialog` pairs its
 * answer with this.
 */
export interface DialogNode {
  ref: string;
  name: string;
  actions: Required<ModalAction>[];
  refs: Set<string>;
}

const DIALOG_ROLES: ReadonlySet<string> = new Set(["dialog", "alertdialog"]);
const ACTION_ROLES: ReadonlySet<string> = new Set(["button", "link"]);

/**
 * Every dialog in the tree, in tree order. A dialog nested in another is
 * its own entry; its controls are its own, not the outer one's, though its
 * elements are inside both.
 */
export const dialogsIn = (nodes: readonly SnapshotNode[]): DialogNode[] => {
  const out: DialogNode[] = [];
  nodes.forEach((node, i) => {
    if (!node.ref || !DIALOG_ROLES.has(node.role)) return;
    const end = subtreeEnd(nodes, i);
    const actions: Required<ModalAction>[] = [];
    const refs = new Set<string>();
    let nestedUntil = -1;
    for (let j = i + 1; j < end; j += 1) {
      const child = nodes[j];
      if (!child?.ref) continue;
      refs.add(child.ref);
      if (j < nestedUntil) continue;
      if (DIALOG_ROLES.has(child.role)) nestedUntil = subtreeEnd(nodes, j);
      else if (
        ACTION_ROLES.has(child.role) &&
        actions.length < DIALOG_ACTIONS_MAX
      ) {
        const label = readName(nodes, j);
        if (label !== "") actions.push({ ref: child.ref, label });
      }
    }
    out.push({ ref: node.ref, name: node.name, actions, refs });
  });
  return out;
};

/**
 * The tree's dialog that a dialog seen in the page is, by what both
 * describe: the accessible name, and the labels of the controls. The page
 * cannot name an element's ref (that lives with Playwright's own script),
 * so the pairing is by public data. When neither names anything (the
 * page saw no controls: they are inside the dialog's own iframe, as on a
 * consent wall), the one unnamed dialog left in the tree is it; with two
 * or more, none is. None matching means the page's dialog is reported by
 * its labels alone. `taken` keeps two open dialogs from pairing with the
 * same node.
 */
export const matchDialog = (
  dialogs: readonly DialogNode[],
  seen: { title: string; labels: readonly string[] },
  taken: ReadonlySet<string>,
): DialogNode | undefined => {
  let best: DialogNode | undefined;
  let bestScore = 0;
  for (const dialog of dialogs) {
    if (taken.has(dialog.ref)) continue;
    let score = dialog.name !== "" && dialog.name === seen.title ? 2 : 0;
    for (const action of dialog.actions)
      if (seen.labels.includes(action.label)) score += 1;
    if (score > bestScore) {
      best = dialog;
      bestScore = score;
    }
  }
  if (best || seen.labels.length > 0) return best;
  const unnamed = dialogs.filter((d) => !taken.has(d.ref) && d.name === "");
  return unnamed.length === 1 ? unnamed[0] : undefined;
};
