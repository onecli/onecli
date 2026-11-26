/**
 * Credential redaction for anything that leaves the sandbox as a log line.
 *
 * The supervisor's stderr leaves the sandbox (a hosted deployment ships it
 * to its operators' log store), so a token that reaches a log line is a token
 * that left the sandbox. The proxy credential (`aoc_`) is the one this
 * process genuinely holds (it rides HTTPS_PROXY, and every tool error that
 * echoes a proxy URL would otherwise carry it), but every other family the
 * platform mints is scrubbed too: the user/org API keys (`oc_`, `oc_org_`),
 * SCIM tokens (`oc_scim_`), the runner (`rnr_`) and channel adapter
 * (`cha_`) credentials. None may appear in a sandbox, and a log line is the
 * last place to catch one that did. A deployment's log
 * pipeline that repeats this rule must mirror the same list.
 *
 * Prefix + at least 16 token characters, never a bare prefix: the floor
 * keeps ordinary words containing a prefix untouched while every real token
 * (32 random bytes, 64 hex chars) is caught. A lookbehind instead of `\b`,
 * so an underscore-glued token (`PROXY_aoc_…`) is still caught while the
 * `oc_` inside `aoc_` is not double-matched. The prefix survives redaction so
 * an operator can still tell WHICH family leaked.
 *
 * A deployment's log pipeline may apply the same rule again
 * downstream: this is the first line, not the only one.
 */
export const TOKEN_PREFIXES = [
  "aoc_",
  "oc_org_",
  "oc_scim_",
  "oc_",
  "rnr_",
  "cha_",
] as const;

const TOKEN_PATTERN = new RegExp(
  `(?<![A-Za-z0-9])(${TOKEN_PREFIXES.join("|")})[A-Za-z0-9]{16,}`,
  "g",
);

export const redactSecrets = (text: string): string =>
  text.replace(TOKEN_PATTERN, "$1[REDACTED]");

/**
 * The JSON.stringify replacer that applies `redactSecrets` to every string
 * VALUE before serialization. Keys are not rewritten (a replacer cannot
 * rename them); every `log()` key is a code literal. Redacting the
 * serialized line instead would miss a token right after a control
 * character: `"\n"` serializes as the two characters `\` `n`, so the `n`
 * sits immediately before the prefix and the lookbehind (correctly)
 * refuses to match, so a multi-line error message ending a line in a proxy
 * URL would leak.
 */
export const redactingReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "string" ? redactSecrets(value) : value;
