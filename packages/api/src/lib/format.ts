export const formatRelative = (dateStr: string, now = Date.now()) => {
  const diff = now - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

export const formatUTC = (dateStr: string) => {
  const date = new Date(dateStr);
  const day = date.getUTCDate();
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day} ${month} ${year} ${h}:${m}:${s} UTC`;
};

export const hasJsonData = (data: unknown): data is Record<string, unknown> =>
  data != null &&
  typeof data === "object" &&
  Object.keys(data as Record<string, unknown>).length > 0;

/**
 * A user- or provider-chosen name about to be spliced into platform voice
 * (a speaker prefix, a card line, a title). The definition lives in
 * @onecli/agent-protocol so the supervisor clamps exactly what the control
 * plane composes; re-exported here to keep every existing import path. From
 * the leaf `./text` subpath: this module is client-reachable, and the
 * package barrel is not browser-safe. Two older cleaners deliberately differ
 * and stay local: channel ingestion's speaker prefix and the cron run header
 * keep interior whitespace runs (no collapse).
 */
export { cleanLabel } from "@onecli/agent-protocol/text";
