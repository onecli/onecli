/**
 * One way to show a stored timestamp (an ISO string from the API) in the
 * viewer's locale and time zone: "Oct 7, 2026, 9:41 PM". A single cached
 * `Intl.DateTimeFormat`, so lists of timestamps stay cheap to render.
 */
const TIMESTAMP = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const formatTimestamp = (iso: string): string =>
  TIMESTAMP.format(new Date(iso));
