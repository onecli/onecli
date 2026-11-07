import { z } from "zod";

/** IANA zone names are short (`America/Argentina/ComodRivadavia` is 32). */
export const TIMEZONE_MAX_LENGTH = 100;

/**
 * Whether `timezone` is an IANA zone this runtime can resolve. The check is
 * the runtime's own table (`Intl`), so aliases resolve too (`Europe/Kyiv`,
 * `Etc/UTC`, `PST`), and so does any letter case (`america/new_york`).
 * Enough for a setting that is consumed by THIS process (a cron's
 * schedule); not enough for one that is handed to another system, see
 * `sandboxTimezoneSchema`.
 */
export const isValidTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The `Area/Location` shape of a zone file as `tzdata` lays them out on disk
 * (`America/Argentina/Buenos_Aires`, `Etc/GMT-3`), with the area pinned to
 * the directories `tzdata` and `tzdata-legacy` actually ship. `UTC` is the
 * one top-level name every system has. `SystemV/` is deliberately not an
 * area: `Intl` resolves its thirteen names, no `tzdata` has shipped them in
 * over a decade.
 */
const ZONE_FILE_SHAPE =
  /^(UTC|(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Brazil|Canada|Chile|Etc|Europe|Indian|Mexico|Pacific|US)(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * Links `tzdata` removed outright (2017 and 2020) that `Intl` still
 * resolves. In the shape above, so only a name check catches them.
 */
const DEAD_LINKS = new Set(["Canada/East-Saskatchewan", "US/Pacific-New"]);

/**
 * A zone for a sandbox's `TZ`. Stricter than `isValidTimezone` on purpose:
 * the value is consumed by libc in the container, which looks the name up
 * as a FILE under its zoneinfo tree and, when the file is missing, keeps
 * UTC without a word. `Intl` alone accepts short ids (`PST`, `EST5EDT`,
 * `Zulu`) that no `tzdata` ships as files, so a setting that passed here
 * would quietly do nothing there. The file shape rules those out, and makes
 * the name case-sensitive the way a file name is (`Intl` would resolve
 * `america/new_york`; libc would not find it). The `Intl` check still
 * rejects a well-shaped name that is not a zone at all (`Mars/Olympus`).
 * Legacy spellings in that shape (`Asia/Calcutta`,
 * `Europe/Kiev`) are accepted: the sandbox image ships `tzdata-legacy`,
 * which has every one `Intl` knows, and a name a person recognizes beats a
 * canonical one they do not.
 */
export const sandboxTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(TIMEZONE_MAX_LENGTH)
  .refine(
    (tz) =>
      ZONE_FILE_SHAPE.test(tz) && !DEAD_LINKS.has(tz) && isValidTimezone(tz),
    {
      message:
        'Unknown timezone. Use an IANA zone name like "America/Los_Angeles"',
    },
  );
