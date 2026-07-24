// Faithful ports of the gateway's request matchers. The new engine must match
// requests EXACTLY as the gateway does, so these mirror the Rust line-for-line
// — keep them in lockstep with the source noted on each function.

/**
 * Port of `apps/gateway/src/inject.rs::path_matches`. Query strings are
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
 * Port of `apps/gateway/src/connect.rs::host_matches`: exact case-insensitive,
 * or a single `*` split into prefix/suffix with a length guard forcing `*` to
 * cover ≥1 char (so `*.example.com` excludes the apex).
 */
export const hostMatches = (requestHost: string, pattern: string): boolean => {
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

/** Port of `apps/gateway/src/policy.rs::is_llm_host` (deny-default bypass). */
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
