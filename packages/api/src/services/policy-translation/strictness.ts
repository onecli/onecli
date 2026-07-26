import type { NewRule } from "./types";

/**
 * Strictness rank shared by the translator (priority assignment, translate/
 * index.ts) and the evaluator (first-match ordering): block strictest (0) …
 * allow loosest (3), reproducing the gateway's
 * Block > ManualApproval > RateLimit > Allow. The two consumers MUST agree — a
 * drift here would silently desync translation from evaluation — so the rank
 * lives in exactly one place.
 */
export const strictnessRank = (rule: NewRule): number => {
  if (rule.action === "block") return 0;
  if (rule.requireApproval) return 1;
  if (rule.rateLimit !== null) return 2;
  return 3;
};
