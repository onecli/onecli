import { LLM_HOST_FRAGMENTS } from "../../lib/llm-hosts";
import type {
  PlatformLlmProvider,
  TrialCreditOwner,
} from "../../providers/platform-llm";

/**
 * Platform-provided Anthropic trial credit — the control-plane half (licensed,
 * cloud-only; the enforcement half is the gateway's `ee/platform_llm.rs`).
 *
 * The control plane never touches the key's VALUE beyond an env presence /
 * shape check: injection happens exclusively at the gateway, so the
 * zero-credential sandbox invariant holds — a hosted container still receives
 * only the `"placeholder"` env var. What this module decides is whether the
 * platform credential WOULD inject for an agent whose pool has no LLM key,
 * so the container config can advertise `ANTHROPIC_API_KEY` (harnesses pick
 * their provider by which variable is set) and the hosted start path can
 * accept a keyless agent instead of refusing to boot it.
 *
 * The two halves stay in agreement by construction: both read the same env
 * vars (a deployment injects the same secret into both processes) and
 * mirror the same key-shape rule (`sk-ant-` prefix — a deployment may
 * provision the secret with a generated placeholder so processes can boot
 * before an operator pastes the real key; the placeholder must read as
 * "unconfigured" on both sides).
 */

/** Mirrors the gateway's `sk-ant-` shape gate (`platform_llm.rs::parse`). */
const looksLikeAnthropicKey = (value: string | undefined): boolean =>
  (value ?? "").trim().startsWith("sk-ant-");

/**
 * Read at call time (not module load) so long-lived processes and tests see
 * the current env — the `policy-flags.ts` posture, chosen over the module-load
 * read because this module is licensed and must be inert when the platform
 * key is withdrawn without a redeploy of every consumer.
 */
const configured = (): boolean =>
  looksLikeAnthropicKey(process.env.PLATFORM_ANTHROPIC_API_KEY);

/**
 * Whether a secret disqualifies the trial credit — the TS mirror of the
 * gateway's `pool_has_llm_credential`: any LLM credential, by provider type
 * or by a host pattern reaching an LLM host, means the user brought their own
 * key. `type` covers anthropic/openai; the fragment scan covers `generic`
 * secrets pointed at any LLM provider.
 */
const isLlmSecret = (secret: { type: string; hostPattern: string }): boolean =>
  secret.type === "anthropic" ||
  secret.type === "openai" ||
  LLM_HOST_FRAGMENTS.some((fragment) => secret.hostPattern.includes(fragment));

/**
 * Consumer mailbox domains the trial credit is NOT granted on. They are
 * handed out free, in bulk, with no phone check, which makes them the
 * cheapest way for a signup farm to collect the credit over and over. Every
 * country variant counts (`outlook.co.uk`, `hotmail.fr`, `live.com.au`): the
 * label before the public suffix is what matters.
 *
 * Everything else is trusted: the mainstream providers (Gmail, iCloud, Yahoo,
 * Proton, ...) and any company or personal domain (`person@company.example`).
 * The Rust twin is `platform_llm.rs::UNTRUSTED_MAIL`; `platform-llm.test.ts`
 * and its Rust counterpart pin the same table.
 */
const UNTRUSTED_MAIL_LABELS: ReadonlySet<string> = new Set([
  "outlook",
  "hotmail",
  "live",
  "msn",
]);

/**
 * Whether `email` is at an untrusted consumer mailbox: its domain's first
 * label is one of UNTRUSTED_MAIL_LABELS and the rest is a short public
 * suffix (`com`, `fr`, `co.uk`, `com.au`). `outlook.acme.com` (a company
 * subdomain) and `liveperson.com` stay trusted. Normalized exactly as the
 * Rust twin does it: whitespace trimmed, every trailing dot dropped, ASCII
 * lowercased (a non-ASCII label never matches the plain-ASCII list).
 */
const atUntrustedMailbox = (email: string): boolean => {
  const domain = email
    .slice(email.lastIndexOf("@") + 1)
    .trim()
    .replace(/\.+$/, "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
  const [first, ...suffix] = domain.split(".");
  return (
    first !== undefined &&
    UNTRUSTED_MAIL_LABELS.has(first) &&
    suffix.length >= 1 &&
    suffix.length <= 2 &&
    suffix.every((label) => /^[a-z]{2,3}$/.test(label))
  );
};

/**
 * Whether the org's founding owner may receive the trial credit. A
 * Google-federated owner always may, whatever the address: a Google account
 * is not something a signup farm can mint by the hundred. Otherwise the
 * address decides. An org with no active owner gets none: there is nobody to
 * judge, and the credit is meant for a person.
 */
export const ownerTrustedForTrialCredit = (
  owner: TrialCreditOwner | null,
): boolean => {
  if (!owner) return false;
  if (owner.signInProvider === "Google") return true;
  return !atUntrustedMailbox(owner.email);
};

export const eePlatformLlm: PlatformLlmProvider = {
  /**
   * Whether the platform trial credit applies to an org/workspace whose
   * UNFILTERED secret pool is `pool` and whose founding owner is `owner`.
   * The pool must be the org+workspace fenced pool BEFORE grant narrowing —
   * an existing-but-restricted LLM key counts as present, so a restriction is
   * never bypassed with free credit (the same rule the gateway applies at
   * connect), and the owner must be trusted (ownerTrustedForTrialCredit).
   */
  trialCreditApplies: (pool, owner) =>
    configured() &&
    !pool.some(isLlmSecret) &&
    ownerTrustedForTrialCredit(owner),
};
