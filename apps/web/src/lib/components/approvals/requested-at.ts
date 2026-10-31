const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When an ask was raised, for the bell and the in-chat cards: relative while
 * fresh ("just now", "2m ago", "3h ago"), the date and time once it is a
 * day old ("Oct 25, 14:06"; the year only when it differs).
 */
export const formatRequestedAt = (
  createdAt: string,
  now: number = Date.now(),
): string => {
  const at = new Date(createdAt);
  const ms = Math.max(0, now - at.getTime());
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  if (ms < DAY_MS) return `${Math.floor(minutes / 60)}h ago`;
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  return at.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/** The full timestamp, for the tooltip. */
export const formatRequestedAtFull = (createdAt: string): string =>
  new Date(createdAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
