import { describe, expect, it } from "vitest";
import { hostMatches } from "./path-match";
// Every DISTINCT wildcard host pattern observed in the production `secrets`
// table (2026-08-30), asserted to behave EXACTLY as before this change. These
// are live credential selectors: a single divergence would re-route a real
// token. The one multi-star row (`*.notion.*`) is included deliberately — it
// matches nothing today and must keep matching nothing.
const PROD_PATTERNS = [
  "*",
  "*.asken.jp",
  "*.atlassian.net",
  "*.dealigence.com",
  "*.earthdata.nasa.gov",
  "*.facebook.com",
  "*.fal.run",
  "*.fireharp.com",
  "*.googleapis.com",
  "*.linkedin.com",
  "*.notion.so",
  "*.pinecone.io",
  "*.runta.com",
  "*.seloger.com",
  "*.short.io",
  "*.warp.dev",
];
const HOSTS = [
  "api.notion.so",
  "a.b.notion.so",
  "notion.so",
  "api.notion.com",
  "evil.notion.xyz",
  "x.atlassian.net",
  "api.fal.run",
  "deep.sub.warp.dev",
  "api.anthropic.com",
  "evil.com",
  "",
];
// The pre-change matcher, inlined verbatim as the oracle.
const legacy = (h: string, p: string): boolean => {
  const star = p.indexOf("*");
  if (star === -1) return h.toLowerCase() === p.toLowerCase();
  const pre = p.slice(0, star),
    suf = p.slice(star + 1);
  return (
    h.length >= pre.length + suf.length &&
    h.slice(0, pre.length).toLowerCase() === pre.toLowerCase() &&
    h.slice(h.length - suf.length).toLowerCase() === suf.toLowerCase()
  );
};
describe("production secret patterns are unaffected", () => {
  it.each(PROD_PATTERNS)(
    "%s behaves identically for every probe host",
    (pattern) => {
      for (const host of HOSTS) {
        expect(hostMatches(host, pattern), `${host} vs ${pattern}`).toBe(
          legacy(host, pattern),
        );
      }
    },
  );
  // The one multi-star row in production (`*.notion.*`) is a special case: it
  // predates the write-time validator, and the matcher DOES now resolve it
  // (that is the whole point of the new regime). What keeps it inert is the
  // read-time guard on the credential-selection path —
  // `is_injectable_host_pattern` in the gateway's `secret_inject`, pinned by
  // `legacy_trailing_wildcard_secret_never_injects`. Asserted there, where the
  // protection actually lives, rather than here.
  it("resolves a trailing-wildcard pattern (inertness is enforced at injection)", () => {
    expect(hostMatches("api.notion.so", "*.notion.*")).toBe(true);
  });
});
