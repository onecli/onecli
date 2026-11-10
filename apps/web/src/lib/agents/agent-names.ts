/**
 * Names a new agent can start with: famous assistants, butlers, sidekicks
 * and right hands from film, TV, books and tech. The New agent dialog opens
 * with one at random and its shuffle button rolls another, so nobody faces
 * an empty box and two new agents rarely share a name.
 *
 * Each entry is a plain first name that passes the display-name rules and
 * makes a clean identifier (letters only).
 */
export const AGENT_NAMES = [
  "Jarvis",
  "Friday",
  "Alfred",
  "Robin",
  "Donna",
  "Moneypenny",
  "Jeeves",
  "Watson",
  "Hal",
  "Karen",
  "Samantha",
  "Pepper",
  "Hudson",
  "Carson",
  "Niles",
  "Benson",
  "Rosie",
  "Joan",
  "Radar",
  "Igor",
  "Smithers",
  "Kitt",
  "Cortana",
  "Edith",
  "Marvin",
  "Baxter",
  "Hughes",
  "Lurch",
  "Woodhouse",
  "Hobson",
  "Passepartout",
  "Sancho",
  "Bunter",
  "Lucius",
  "Felicity",
  "Gromit",
  "Dobby",
  "Cogsworth",
  "Lumiere",
  "Belvedere",
  "Hazel",
  "Geoffrey",
  "Pennyworth",
  "Wadsworth",
  "Gerty",
  "Tars",
  "Ava",
  "Bishop",
  "Data",
  "Chip",
] as const;

/**
 * A random name, skipping the ones already taken (agent names are unique
 * per workspace, case-insensitively) and the one showing now, so shuffle
 * always changes it. When every name is taken it falls back to any other
 * name, and the dialog's own validation explains a clash.
 */
export const randomAgentName = (
  taken: Iterable<string> = [],
  current?: string,
): string => {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const notCurrent = AGENT_NAMES.filter(
    (n) => n.toLowerCase() !== current?.trim().toLowerCase(),
  );
  const free = notCurrent.filter((n) => !used.has(n.toLowerCase()));
  const pool = free.length > 0 ? free : notCurrent;
  return pool[Math.floor(Math.random() * pool.length)]!;
};
