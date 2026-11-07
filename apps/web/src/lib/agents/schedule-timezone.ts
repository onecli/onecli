/** The viewer's IANA zone, the default a new schedule is written in (both
 * the agent crons and the eval schedule read their expression in it). */
export const browserTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
