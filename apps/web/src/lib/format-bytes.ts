const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * One way to show a byte count: the number through Intl (locale digits and
 * separators, one decimal past bytes), the unit as the plain abbreviation
 * everyone reads, joined with a non-breaking space so they never wrap
 * apart. "812 B", "4.2 KB", "1.5 MB".
 */
export const formatBytes = (bytes: number): string => {
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  const number = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(value);
  return `${number}\u00a0${UNITS[index]}`;
};
