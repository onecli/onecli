import { parse } from "tldts";

/**
 * Shared mailbox providers: an address there says nothing about the person's
 * company. Matched on the registrable domain, so a provider's own
 * subdomains count too.
 */
const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "tuta.io",
  "tutanota.com",
  "yahoo.com",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
]);

/**
 * Provider brands distinctive enough that every regional variant is the
 * same provider (`hotmail.co.uk`, `yahoo.co.jp`, `gmx.de`, `outlook.co.il`).
 * Generic words (`me`, `live`, `mail`, `pm`, `hey`) are left out: a company
 * may well own `hey.app` or `live.io`, and only the exact domains above
 * belong to the provider.
 */
const PUBLIC_EMAIL_BRANDS: ReadonlySet<string> = new Set([
  "aol",
  "fastmail",
  "gmail",
  "gmx",
  "googlemail",
  "hotmail",
  "icloud",
  "msn",
  "outlook",
  "protonmail",
  "tutanota",
  "yahoo",
  "yandex",
  "ymail",
  "zoho",
]);

/**
 * An email domain split under the Public Suffix List: the registrable
 * domain (`acme.co.uk` for `eu.acme.co.uk`) and its label (`acme`). Null
 * for a domain with no registrable part (`localhost`, a bare suffix, an
 * IP).
 *
 * The input is already a hostname, so tldts's own URL-ish extraction is off
 * (its README's advice). Private suffixes count, so a company on a hosted
 * zone (`acme.github.io`) is still `acme`. The DNS root dot is dropped
 * first: tldts reads `acme.com.` as the domain `com.`.
 */
const registrableOf = (
  domain: string,
): { domain: string; label: string } | null => {
  const parsed = parse(domain.trim().toLowerCase().replace(/\.$/, ""), {
    allowPrivateDomains: true,
    extractHostname: false,
  });
  return parsed.domain && parsed.domainWithoutSuffix
    ? { domain: parsed.domain, label: parsed.domainWithoutSuffix }
    : null;
};

const isProvider = (registrable: { domain: string; label: string }) =>
  PUBLIC_EMAIL_DOMAINS.has(registrable.domain) ||
  PUBLIC_EMAIL_BRANDS.has(registrable.label);

/**
 * Whether an email domain is a shared mailbox provider, regional variants
 * included. A company subdomain that happens to share a provider's name
 * (`mail.acme.com`, `me.acme.com`) is the company's, never the provider's.
 */
export const isPublicEmailDomain = (domain: string): boolean => {
  const registrable = registrableOf(domain);
  return registrable !== null && isProvider(registrable);
};

/**
 * The name a person's first organization is born with.
 *
 * A company address names it after the company, without the domain ending
 * or any subdomain: `dana@acme.com` → `acme`, `dana@eu.acme-labs.co.uk` →
 * `acme-labs`. A shared mailbox provider (gmail, hotmail, …) says nothing
 * about the company, so it is named after the person:
 * `dana.cohen@gmail.com` → `dana.cohen`. Null when the address has nothing
 * usable, so the caller keeps its own fallback.
 */
export const orgNameFromEmail = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const local = email.slice(0, at).trim() || null;
  const registrable = registrableOf(email.slice(at + 1));
  if (registrable === null || isProvider(registrable)) return local;
  return registrable.label;
};
