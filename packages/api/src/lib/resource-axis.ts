import {
  isSessionPolicy,
  type SessionPolicyInput,
} from "../validations/policy";

/**
 * Resource axes — the TS twin of the gateway's `ee/granular_access.rs`
 * `ResourceAxis`, and the single definition of what "one resource is inside
 * another" means for a session policy ("Resources": which repositories or
 * folders an injected credential may reach).
 *
 * It lives here, outside `ee/`, because the shared reflection and grants
 * services compose scopes and must build standalone. The functions are pure and
 * inert in editions that store no session policies.
 *
 * ⚠ These rules must stay byte-identical to the gateway's — the gateway is what
 * actually enforces them, and a divergence would show the operator one scope
 * while applying another. That extends to value semantics, not just structure:
 * case folding is ASCII-only and Dropbox targets must be absolute, because that
 * is precisely what `to_ascii_lowercase` and `path_allowed` do in Rust. The
 * Rust tests and `resource-axis.test.ts` cover the same cases on purpose.
 */

/** `str::to_ascii_lowercase` — NOT `toLowerCase()`, which also folds non-ASCII
 * (so `/Ärende` would match `/ärende` here but not at the gateway). */
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (c) => c.toLowerCase());

interface ResourceAxis {
  readonly key: "repositories" | "folders";
  normalize(entry: string): string;
  coveredBy(entry: string, boundary: readonly string[]): boolean;
  /** This axis's entries, or undefined when the policy doesn't carry the axis
   * as a list. Structural, so no cast is needed at the call site. */
  entriesOf(policy: SessionPolicyInput): string[] | undefined;
  /** The policy object for this axis — keeps the union's shape exact. */
  build(entries: string[]): SessionPolicyInput;
}

/** Repository full names are flat and case-insensitive: one is inside another
 * only by being the same one. */
const repositories: ResourceAxis = {
  key: "repositories",
  normalize: asciiLower,
  coveredBy: (entry, boundary) => {
    const target = asciiLower(entry);
    return boundary.some((b) => asciiLower(b) === target);
  },
  entriesOf: (policy) =>
    "repositories" in policy ? policy.repositories : undefined,
  build: (entries) => ({ repositories: entries }),
};

/** Dropbox paths are case-insensitive, `/`-separated, and nest; the account
 * root is the empty string (and contains everything). */
const folders: ResourceAxis = {
  key: "folders",
  normalize: (entry) => asciiLower(entry).replace(/\/+$/, ""),
  coveredBy: (entry, boundary) => {
    const normalized = boundary.map((b) => folders.normalize(b));
    // A root boundary contains every path.
    if (normalized.some((b) => b === "")) return true;
    // Only absolute paths are verifiable (`id:`/`rev:` refs are not), mirroring
    // the gateway's `path_allowed`.
    if (!entry.startsWith("/")) return false;
    const target = folders.normalize(entry);
    if (target === "") return false; // the account root is not "inside" anything
    // Segment boundary, so `/foo` does not contain `/foobar`.
    return normalized.some((b) => target === b || target.startsWith(`${b}/`));
  },
  entriesOf: (policy) => ("folders" in policy ? policy.folders : undefined),
  build: (entries) => ({ folders: entries }),
};

const AXES: readonly ResourceAxis[] = [repositories, folders];

/** The axis a policy is written on, by its single key. */
export const axisOf = (policy: unknown): ResourceAxis | undefined => {
  if (!isSessionPolicy(policy)) return undefined;
  return AXES.find((axis) => axis.key in policy);
};

/** The policy's raw (un-normalized) entries, or undefined when the axis key
 * holds something other than a list — which is not a restriction at all. */
const rawEntries = (
  policy: SessionPolicyInput,
  axis: ResourceAxis,
): string[] | undefined => {
  const entries = axis.entriesOf(policy);
  return Array.isArray(entries)
    ? entries.filter((e): e is string => typeof e === "string")
    : undefined;
};

/**
 * Whether a policy restricts its credential to NOTHING — an explicitly empty
 * allowlist. It is how an empty scope composition is represented, and reading
 * it as "unrestricted" would be the worst possible default: for GitHub an empty
 * list omitted from the mint request yields a token for EVERY repository.
 *
 * Deliberately evaluated on the raw entries: normalization drops values like
 * `"/"`, and a policy that listed only those still means "restrict".
 */
export const deniesEverything = (policy: unknown): boolean => {
  const axis = axisOf(policy);
  if (!axis || !isSessionPolicy(policy)) return false;
  return rawEntries(policy, axis)?.length === 0;
};

/** Whether one resource entry lies entirely inside a boundary policy. */
export const coveredBy = (entry: string, boundary: unknown): boolean => {
  const axis = axisOf(boundary);
  if (!axis || !isSessionPolicy(boundary)) return true; // unbounded
  return axis.coveredBy(entry, rawEntries(boundary, axis) ?? []);
};

/** The entries of `policy` that fall outside `boundary` — what a write-time
 * containment check reports back to the user. Axes that disagree overlap in
 * nothing, so every entry is outside (the same fail-closed reading the gateway
 * applies when composing). */
export const entriesOutside = (
  policy: unknown,
  boundary: unknown,
): string[] => {
  const axis = axisOf(policy);
  const boundaryAxis = axisOf(boundary);
  if (!axis || !isSessionPolicy(policy) || boundaryAxis === undefined) {
    return [];
  }
  const entries = rawEntries(policy, axis) ?? [];
  if (boundaryAxis.key !== axis.key) return entries;
  return entries.filter((entry) => !coveredBy(entry, boundary));
};

/**
 * Compose two session policies into what the credential may actually reach: the
 * overlap of both. `null`/absent on either side means "unrestricted there", so
 * the other side stands alone.
 *
 * SYMMETRIC — an entry survives when it is inside the other side, whichever
 * side it came from. For nesting axes that keeps the narrower of a nested pair
 * (boundary `/clients/acme` with selection `/clients` yields `/clients/acme`)
 * instead of discarding a real overlap.
 */
export const intersectPolicies = (
  a: unknown,
  b: unknown,
): SessionPolicyInput | null => {
  const axisA = axisOf(a);
  const axisB = axisOf(b);
  if (!axisA || !isSessionPolicy(a))
    return axisB && isSessionPolicy(b) ? b : null;
  if (!axisB || !isSessionPolicy(b)) return a;
  if (axisA.key !== axisB.key) {
    // Different dimensions cannot overlap (one provider, one axis) — a
    // misconfiguration, and the safe reading is "nothing is in both".
    return axisA.build([]);
  }
  const entriesA = rawEntries(a, axisA) ?? [];
  const entriesB = rawEntries(b, axisB) ?? [];
  const kept = [
    ...entriesA.filter((entry) => axisA.coveredBy(entry, entriesB)),
    ...entriesB.filter((entry) => axisA.coveredBy(entry, entriesA)),
  ].map((entry) => axisA.normalize(entry));
  // Deterministic: the composed value is part of the gateway's injection cache
  // key, so an unstable order would multiply cache misses.
  return axisA.build([...new Set(kept)].sort());
};
