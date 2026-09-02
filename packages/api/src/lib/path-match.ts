// Faithful ports of the gateway's request matchers. The new engine must match
// requests EXACTLY as the gateway does, so these mirror the Rust line-for-line
// — keep them in lockstep with the source noted on each function.

/**
 * Port of `apps/gateway/crates/inject/src/lib.rs::path_matches`. Query strings are
 * stripped first, then five rules in order:
 *   "*" ; mid-path segment glob ; "/p/*" (prefix + "/" boundary, also matches
 *   bare "/p") ; "/p*" (raw prefix) ; exact.
 */
export const pathMatches = (requestPath: string, pattern: string): boolean => {
  const path = requestPath.split("?")[0] ?? requestPath;
  if (pattern === "*") return true;
  if (hasMidPathWildcard(pattern)) return segmentWildcardMatches(path, pattern);
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return (
      path === prefix ||
      (path.startsWith(prefix) && path[prefix.length] === "/")
    );
  }
  if (pattern.endsWith("*")) {
    return path.startsWith(pattern.slice(0, -1));
  }
  return path === pattern;
};

// `pattern[..len-1].contains('*')` — a `*` anywhere except the last char.
const hasMidPathWildcard = (pattern: string): boolean =>
  pattern.length > 1 && pattern.slice(0, -1).includes("*");

/**
 * Port of `segment_wildcard_matches`. Each `*` matches within one segment
 * (never crossing `/`), except a trailing standalone `*` which matches 1+
 * remaining segments.
 */
const segmentWildcardMatches = (path: string, pattern: string): boolean => {
  const pathSegs = path.split("/");
  const patSegs = pattern.split("/");
  const trailingWild = patSegs[patSegs.length - 1] === "*";
  const fixedPats = trailingWild ? patSegs.slice(0, -1) : patSegs;

  if (trailingWild) {
    if (pathSegs.length < fixedPats.length + 1) return false;
  } else if (pathSegs.length !== patSegs.length) {
    return false;
  }

  for (let i = 0; i < fixedPats.length; i++) {
    if (!segmentMatches(pathSegs[i] ?? "", fixedPats[i] ?? "")) return false;
  }
  return true;
};

// Port of `segment_matches`: a `*` inside a segment is `prefix*suffix`.
const segmentMatches = (segment: string, pattern: string): boolean => {
  const pos = pattern.indexOf("*");
  if (pos === -1) return segment === pattern;
  const prefix = pattern.slice(0, pos);
  const suffix = pattern.slice(pos + 1);
  return (
    segment.startsWith(prefix) &&
    segment.endsWith(suffix) &&
    segment.length >= prefix.length + suffix.length
  );
};

/**
 * ASCII-only case folding, matching Rust's `to_ascii_lowercase` /
 * `to_ascii_uppercase` / `eq_ignore_ascii_case`. JS `toLowerCase()` folds the
 * full Unicode range (İ→i̇, K→k), which would diverge from the gateway on a
 * non-ASCII host or condition value; these fold only `A-Z`/`a-z`.
 */
export const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
export const asciiUpper = (s: string): string =>
  s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));

/**
 * Port of `apps/gateway/crates/proxy/src/connect.rs::host_matches`: exact case-insensitive,
 * or a single `*` split into prefix/suffix with a length guard forcing `*` to
 * cover ≥1 char (so `*.example.com` excludes the apex).
 */
export const hostMatches = (requestHost: string, pattern: string): boolean => {
  // TWO REGIMES, split on wildcard count — mirrors `host_matches` in
  // `apps/gateway/crates/common/src/util.rs`.
  //
  // 0 or 1 `*` takes the original path below, byte for byte. That is
  // deliberate: the single-`*` form is a prefix/suffix split that spans label
  // boundaries, so `*.example.com` matches `a.b.example.com`. Live secrets rely
  // on that reach; narrowing it would silently stop injecting credentials that
  // work today.
  //
  // 2+ `*` cannot be expressed that way at all — the split treats everything
  // after the first `*` as literal, so such a pattern matches NOTHING. Those
  // get the label-bounded matcher instead.
  if (countChar(pattern, "*") >= 2) {
    return multiWildcardMatches(requestHost, pattern);
  }
  const star = pattern.indexOf("*");
  if (star === -1) {
    return asciiLower(requestHost) === asciiLower(pattern);
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    requestHost.length >= prefix.length + suffix.length &&
    asciiLower(requestHost.slice(0, prefix.length)) === asciiLower(prefix) &&
    asciiLower(requestHost.slice(requestHost.length - suffix.length)) ===
      asciiLower(suffix)
  );
};

const countChar = (value: string, ch: string): number => {
  let n = 0;
  for (const c of value) if (c === ch) n += 1;
  return n;
};

/**
 * Port of `multi_wildcard_matches`: label-bounded matching for a pattern
 * carrying 2+ wildcards, e.g. `*.s3.*.amazonaws.com` (a virtual-hosted S3
 * bucket in any region) — a shape needing two independent blanks that no
 * single-`*` pattern can express without swallowing sibling services.
 *
 * Every rule fails CLOSED, because a host pattern decides where a credential is
 * injected: label counts must be equal (a `*` is exactly ONE label, so the
 * pattern stays anchored to a fixed depth), every `*` consumes at least one
 * character, empty labels never match, and at most one `*` per label.
 *
 * The trailing-label question (`*.notion.*`, which would span every TLD
 * including attacker-registrable ones) is settled earlier, at write time, by
 * `hostPatternSchema`. This matcher stays mechanical so both ports compare
 * literally.
 */
const multiWildcardMatches = (
  requestHost: string,
  pattern: string,
): boolean => {
  const hostLabels = requestHost.split(".");
  const patternLabels = pattern.split(".");
  if (hostLabels.length !== patternLabels.length) return false;
  return hostLabels.every((hostLabel, i) =>
    labelMatches(hostLabel, patternLabels[i] ?? ""),
  );
};

/** One host label against one pattern label: literal, or a single `*` standing
 * in for 1+ characters within THIS label only. */
const labelMatches = (hostLabel: string, patternLabel: string): boolean => {
  if (hostLabel.length === 0) return false;
  const star = patternLabel.indexOf("*");
  if (star === -1) return asciiLower(hostLabel) === asciiLower(patternLabel);
  const prefix = patternLabel.slice(0, star);
  const suffix = patternLabel.slice(star + 1);
  // A second `*` in the same label buys nothing and only widens — refuse.
  if (suffix.includes("*")) return false;
  return (
    // `>` (not `>=`) forces the `*` to consume at least one character.
    hostLabel.length > prefix.length + suffix.length &&
    asciiLower(hostLabel.slice(0, prefix.length)) === asciiLower(prefix) &&
    asciiLower(hostLabel.slice(hostLabel.length - suffix.length)) ===
      asciiLower(suffix)
  );
};

/** Port of `apps/gateway/crates/policy/src/lib.rs::is_llm_host` (deny-default bypass). */
export const isLlmHost = (host: string): boolean => {
  const h = host.split(":")[0] ?? host;
  return (
    h.includes("anthropic.com") ||
    h.includes("openai.com") ||
    h.includes("chatgpt.com") ||
    h.includes("deepseek.com") ||
    h.includes("groq.com") ||
    h.includes("openrouter.ai") ||
    h.includes("moonshot.cn") ||
    h.includes("generativelanguage.googleapis.com")
  );
};
