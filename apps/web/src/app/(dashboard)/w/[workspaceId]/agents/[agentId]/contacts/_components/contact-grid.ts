/**
 * The Contacts table's columns, shared by a group's header and its rows so
 * they line up: name | As the agent | As you: Reads | Writes | `…`.
 * Every control column has a fixed width with content aligned to its
 * start, and dividers separate the name, "as the agent", "as you" and the
 * menu. Below md the two "as you" cells wrap under the name.
 */
export const AS_YOU_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_36px] items-center gap-x-3 md:grid-cols-[minmax(0,1fr)_264px_132px_132px_36px] md:gap-x-0";

/** The first "as you" cell carries the divider between the two identities. */
export const AS_YOU_FIRST_CELL =
  "md:border-l md:border-foreground/20 dark:md:border-border";

/** Between Read history and Write for you: a short, faint tick. */
export const WRITE_CELL =
  "md:relative md:before:absolute md:before:left-0 md:before:top-1/4 md:before:h-1/2 md:before:w-px md:before:bg-foreground/15 dark:md:before:bg-border";

/** The "as the agent" cell: a lighter divider after the name column. */
export const AGENT_CELL =
  "md:border-l md:border-foreground/10 dark:md:border-border/60";

/** The trailing menu cell: a lighter divider before the `…`. */
export const MENU_CELL =
  "md:border-l md:border-foreground/10 dark:md:border-border/60";
