/**
 * One way to show a duration of whole seconds (an awake time, a run length)
 * compactly: "3m", "2h 15m", "1d 4h". Minutes are the floor of what is
 * shown; sub-minute values read "< 1m" rather than a count of seconds the
 * reader would not act on. Zero is "0m".
 */
export const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return "0m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "< 1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
};
