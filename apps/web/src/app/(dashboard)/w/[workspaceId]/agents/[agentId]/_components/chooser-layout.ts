/**
 * The new agent's "choose connections" window lays its Apps and Custom tabs
 * out the same way, so switching tabs never changes the window's shape. The
 * shapes live here once, for both tabs and both row kinds.
 */

/** The tiles' grid: one column on phones, two on tablets, three wide. */
export const chooserGridClassName =
  "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3";

/** One tile of the grid: a grant row in its `compact` shape. */
export const chooserTileClassName =
  "min-w-0 gap-3 rounded-lg border px-3 py-2.5";

/** An empty tab: borderless, filling the window's fixed-height body, so an
 * empty tab is the same size as a full one. Merged over the empty-state
 * card's own classes. */
export const chooserEmptyClassName = "h-full border-0 bg-transparent py-0";
