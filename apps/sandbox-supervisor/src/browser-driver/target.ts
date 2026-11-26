/**
 * What a verb acts on, and how the driver finds it. An agent names an
 * element one of two ways, both read off the element list a reply prints
 * (`e12 button "Send"`):
 *
 * - by its ref, `e12`: exact, and right after reading the reply. A ref is
 *   one element of one document: the frame's load sequence is part of it
 *   (`f1e12` after a navigation), so a ref from before a page change never
 *   lands on the new page, even when the same button sits there.
 * - by its role and name as the line prints them, `button "Send"`: stable
 *   across page loads, so a script that does the same steps over many pages
 *   does not have to cut a ref out of each reply (observed live: an agent
 *   reused `e8` after the next `open` and was refused; the button was
 *   `f1e8` by then).
 *
 * A name is matched exactly, on the element list of the tab's last
 * snapshot, and a target that matches more than one element is refused
 * with their refs: a guess is how an agent clicks the wrong "Delete".
 *
 * Pure and dependency-free: the command's bundle imports this file for the
 * grammar (bundle.test.ts keeps that bundle at node's own modules), and the
 * driver for the lookup.
 */

/** One element of the list a reply prints. */
export interface Element {
  ref: string;
  role: string;
  name: string;
}

/** What a verb names: a ref, or a role and a name as the list prints them. */
export type Target = { ref: string } | { role: string; name: string };

/** A ref as the snapshot prints it: `e12`, or `f1e12` in a frame or after a navigation. */
export const REF = /^(f\d+)?e\d+$/;
/** A role as the snapshot prints it. */
export const ROLE = /^[a-z]+$/;

/** A role and a name as the agent types them: `button "Send"`. */
const roleName = (role: string, name: string): string => `${role} "${name}"`;

/** A target as the agent types it back: `e12`, or `button "Send"`. */
export const describeTarget = (target: Target): string =>
  "ref" in target ? target.ref : roleName(target.role, target.name);

/** An element as its line in the list reads: `e12 button "Send"`. */
const describeElement = (element: Element): string =>
  element.name === ""
    ? `${element.ref} ${element.role}`
    : `${element.ref} ${roleName(element.role, element.name)}`;

/** The most refs, or near misses, one refusal lists; past this it is noise. */
const LISTED_MAX = 5;

const listed = (items: readonly string[]): string =>
  items.length > LISTED_MAX
    ? `${items.slice(0, LISTED_MAX).join(", ")}, …`
    : items.join(", ");

/** A ref's document: the frame's load sequence in front (`f2` of `f2e15`), or "" for the first. */
const documentOf = (ref: string): string => /^f\d+/.exec(ref)?.[0] ?? "";

/**
 * The elements of one snapshot, indexed both ways. Built once per reply
 * from the list it prints; every lookup after that is a map read.
 */
export class ElementIndex {
  readonly #byRef = new Map<string, Element>();
  readonly #byRoleName = new Map<string, Element[]>();
  /**
   * Which page this snapshot is of: the load sequence on the refs of its
   * top document (the first element's; iframes come after it in tree
   * order). Two snapshots of one page share it, a navigation changes it.
   */
  readonly document: string;

  constructor(elements: Iterable<Element>) {
    let document: string | undefined;
    for (const element of elements) {
      document ??= documentOf(element.ref);
      this.#byRef.set(element.ref, element);
      const key = keyOf(element.role, element.name);
      const same = this.#byRoleName.get(key);
      if (same) same.push(element);
      else this.#byRoleName.set(key, [element]);
    }
    this.document = document ?? "";
  }

  /** The element a ref names, if this snapshot printed it. */
  get(ref: string): Element | undefined {
    return this.#byRef.get(ref);
  }

  /** Every element with exactly this role and name, in page order. */
  named(role: string, name: string): readonly Element[] {
    return this.#byRoleName.get(keyOf(role, name)) ?? [];
  }

  /**
   * What the agent most likely meant when a role and name matched
   * nothing: the same name under another role (it called a link a
   * button), else names of that role that contain the one asked for, or
   * that it contains, ignoring case ("Send" for "Send now").
   */
  closeTo(role: string, name: string): Element[] {
    const sameName: Element[] = [];
    const similar: Element[] = [];
    const wanted = name.toLowerCase();
    for (const element of this.#byRef.values()) {
      if (element.name === "") continue;
      if (element.name === name) sameName.push(element);
      else if (element.role === role) {
        const have = element.name.toLowerCase();
        if (have.includes(wanted) || wanted.includes(have))
          similar.push(element);
      }
    }
    return (sameName.length > 0 ? sameName : similar).slice(0, LISTED_MAX);
  }
}

/** Map key for a role and a name; the role never contains the separator. */
const keyOf = (role: string, name: string): string => `${role}\u0000${name}`;

/** A target resolved to the one ref it names, or the reason it names none. */
export type Resolved = { ref: string } | { error: string };

/**
 * The one element `target` names in `elements`, the tab's last snapshot.
 *
 * - A ref is the element it names, or nothing. When it is not in the last
 *   snapshot but was in the one before (the page loaded again under it),
 *   the refusal says what it was and what that element is called now. It
 *   never acts on the new ref: the agent decides.
 * - A role and a name match exactly. More than one match is refused with
 *   the refs to choose from, except while a modal is open and exactly one
 *   of the matches is inside it (`within`: a "Cancel" in the dialog and
 *   another on the page behind it, which no action could reach anyway).
 */
export const resolveTarget = (
  target: Target,
  elements: ElementIndex,
  context: { previous?: ElementIndex; within?: ReadonlySet<string> } = {},
): Resolved => {
  if ("ref" in target) {
    if (elements.get(target.ref)) return { ref: target.ref };
    const missing = `ref ${target.ref} is not in the last snapshot of this tab`;
    const was = context.previous?.get(target.ref);
    if (!was || was.name === "")
      return { error: `${missing}; take a new snapshot` };
    const named = roleName(was.role, was.name);
    const now = elements.named(was.role, was.name);
    return {
      error:
        now.length === 1 && now[0]
          ? `${missing}; it was ${named}, now ${now[0].ref} (or name it: ${named})`
          : `${missing}; it was ${named}; take a new snapshot`,
    };
  }
  const matches = elements.named(target.role, target.name);
  const inside = matches.filter((m) => context.within?.has(m.ref));
  const one =
    matches.length === 1
      ? matches[0]
      : inside.length === 1
        ? inside[0]
        : undefined;
  if (one) return { ref: one.ref };
  const named = describeTarget(target);
  if (matches.length > 1)
    return {
      error: `${named} matches ${String(matches.length)} elements: ${listed(matches.map((m) => m.ref))}; use the ref of the one you mean${matches.length > LISTED_MAX ? " (the element list shows all of them)" : ""}`,
    };
  const close = elements.closeTo(target.role, target.name);
  return {
    error:
      close.length > 0
        ? `no ${named} in the last snapshot of this tab; close: ${listed(close.map(describeElement))}`
        : `no ${named} in the last snapshot of this tab; take a new snapshot and use a name exactly as a line shows it`,
  };
};
