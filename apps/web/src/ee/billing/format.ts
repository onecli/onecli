export const formatDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Whole-dollar price, e.g. 199000 -> "$1,990" (matches the plan cards). */
export const formatWholeDollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;

export const pct = (current: number, total: number) =>
  total > 0 ? Math.min((current / total) * 100, 100) : 0;
