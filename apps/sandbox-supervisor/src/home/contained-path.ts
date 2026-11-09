import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * A path the agent named, resolved to its REAL location and checked
 * against the home's real location: the one rule for a file that leaves
 * the sandbox by the agent's hand (`send_file` to a person, `onecli-browser
 * upload` to a website). Lexical containment first (cheap, and `..` never
 * gets to touch the filesystem), then realpath so a symlink anywhere in
 * the chain cannot point the read outside the home: a symlink INTO the home
 * is fine (`~/latest -> ~/runs/3/clip.webm`), one out of it is refused
 * whether at the leaf or in a parent.
 *
 * What this is and is not: the agent can read anything its uid can read
 * and copy it into the home first, so containment is a DISCIPLINE (files
 * leave from the agent's own space, by a path it can name) rather than a
 * boundary against the agent. It is the boundary against a page or a
 * prompt that names a path the agent never meant to send.
 *
 * Errors are the caller's to word: `outside` for the home rule, `missing`
 * for ENOENT (the common case, not an attack), `unresolvable` with the
 * code for the rest.
 */
export type ContainmentReason = "outside" | "missing" | "loop" | "unresolvable";

export type ContainedPath =
  | { ok: true; path: string }
  | { ok: false; reason: ContainmentReason; code?: string };

export const containedPath = (home: string, raw: string): ContainedPath => {
  const root = resolve(home);
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!within(root, candidate)) return { ok: false, reason: "outside" };
  let real: string;
  let realHome: string;
  try {
    realHome = realpathSync(root);
    real = realpathSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { ok: false, reason: "missing" };
    if (code === "ELOOP") return { ok: false, reason: "loop" };
    return { ok: false, reason: "unresolvable", ...(code ? { code } : {}) };
  }
  if (!within(realHome, real)) return { ok: false, reason: "outside" };
  return { ok: true, path: real };
};

/** Strictly under `root`: not the root itself, and no `..` on the way. */
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return !rel.split(sep).some((seg) => seg === "..");
};
