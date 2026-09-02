import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";

/**
 * Public email providers that can never be claimed as an organization's
 * domain — a verified domain grants org-level trust over every address on
 * it (SSO routing, JIT membership, identity linking), which must never
 * apply to a shared mailbox provider.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tuta.io",
]);

/** Post-normalization shape: ascii labels + a 2+ char TLD. */
const DOMAIN_SHAPE = /^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/;

/** The TXT record value is `onecli-verification=<token>`. */
export const TXT_RECORD_PREFIX = "onecli-verification=";

/**
 * DNS TXT lookup — `resolveTxt` returns one entry per record, each split
 * into chunks that must be joined. Injectable so tests never hit the
 * network.
 */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

const domainSelect = {
  id: true,
  domain: true,
  verificationToken: true,
  verifiedAt: true,
  createdAt: true,
} as const;

/** Lowercase + punycode + exact-domain shape, or BAD_REQUEST. */
const normalizeDomain = (raw: string): string => {
  const ascii = domainToASCII(raw.trim().toLowerCase()).replace(/\.$/, "");
  if (!ascii || !DOMAIN_SHAPE.test(ascii)) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Enter a valid domain like example.com",
    );
  }
  return ascii;
};

/**
 * The domain part of an email, normalized exactly like stored
 * organization_domains rows (so equality against them is trustworthy) —
 * or null when the email has no valid domain. Non-throwing: callers on
 * login paths skip rather than error.
 *
 * The PreSignUp Lambda re-implements this as `normalizeEmailDomain`
 * (packages/infra/lambdas/pre-signup/linking.ts) because it can't import this
 * package — keep the two in lockstep.
 */
export const emailDomainOf = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const ascii = domainToASCII(
    email
      .slice(at + 1)
      .trim()
      .toLowerCase(),
  ).replace(/\.$/, "");
  if (!ascii || !DOMAIN_SHAPE.test(ascii)) return null;
  return ascii;
};

export const listDomains = (organizationId: string) =>
  db.organizationDomain.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: domainSelect,
  });

export const createDomain = async (
  organizationId: string,
  rawDomain: string,
  createdByUserId: string,
) => {
  const domain = normalizeDomain(rawDomain);
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Public email providers can't be claimed. Use your company's domain.",
    );
  }
  try {
    return await db.organizationDomain.create({
      data: {
        organizationId,
        domain,
        verificationToken: randomBytes(16).toString("hex"),
        createdByUserId,
      },
      select: domainSelect,
    });
  } catch (err) {
    // `domain` is globally unique: one org per domain, verified or not.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "This domain is already claimed by an organization.",
      );
    }
    throw err;
  }
};

export const verifyDomain = async (
  organizationId: string,
  domainId: string,
  resolver: TxtResolver = resolveTxt,
) => {
  const row = await db.organizationDomain.findFirst({
    where: { id: domainId, organizationId },
    select: domainSelect,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Domain not found");
  if (row.verifiedAt) return row; // already verified — idempotent

  const expected = `${TXT_RECORD_PREFIX}${row.verificationToken}`;
  let records: string[][] = [];
  try {
    records = await resolver(row.domain);
  } catch {
    // ENOTFOUND / ENODATA / servfail — treated as "record not there yet".
  }
  const found = records.some((chunks) => chunks.join("") === expected);
  if (!found) {
    throw new ServiceError(
      "BAD_REQUEST",
      "TXT record not found yet. DNS changes can take a few minutes to propagate.",
    );
  }

  return db.organizationDomain.update({
    where: { id: row.id },
    data: { verifiedAt: new Date() },
    select: domainSelect,
  });
};

export const deleteDomain = async (
  organizationId: string,
  domainId: string,
) => {
  const { count } = await db.organizationDomain.deleteMany({
    where: { id: domainId, organizationId },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Domain not found");
};
