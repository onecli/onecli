import { ScimError } from "./errors";

/**
 * The SCIM filter subset provisioning IdPs actually send: `attr eq "value"`.
 * Okta filters /Users by `userName eq` and /Groups by `displayName eq`;
 * Entra's Test Connection probes `userName eq "<random guid>"`. Attribute
 * names and the operator are case-insensitive (RFC 7643 §2.1 / 7644 §3.4.2.2);
 * everything beyond a single `eq` comparison is rejected as invalidFilter —
 * explicit beats silently returning the wrong page.
 */

export interface ScimEqFilter {
  /** Lowercased attribute name, sub-attribute dots preserved. */
  attribute: string;
  value: string;
}

// attr eq "value" — value is a double-quoted string with \-escapes.
const EQ_FILTER =
  /^\s*([a-zA-Z][a-zA-Z0-9._-]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

const unescapeQuoted = (raw: string): string =>
  raw.replace(/\\(.)/g, (_match, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      default:
        return ch; // \" \\ \/ and anything else → the literal character
    }
  });

export const parseEqFilter = (filter: string): ScimEqFilter => {
  const match = EQ_FILTER.exec(filter);
  if (!match) {
    throw new ScimError(
      400,
      `Unsupported filter "${filter}". This endpoint supports a single equality comparison: attribute eq "value".`,
      "invalidFilter",
    );
  }
  return {
    attribute: match[1]!.toLowerCase(),
    value: unescapeQuoted(match[2]!),
  };
};

/**
 * Parse a filter and require the attribute to be one of the supported names
 * (lowercased). `hint` tells the IdP admin what this resource CAN match on —
 * e.g. /Users has no stored externalId, so `externalId eq` gets a 400 with
 * "match users by userName" guidance instead of silently matching nothing.
 */
export const parseSupportedEqFilter = (
  filter: string,
  supported: readonly string[],
  hint: string,
): ScimEqFilter => {
  const parsed = parseEqFilter(filter);
  if (!supported.includes(parsed.attribute)) {
    throw new ScimError(
      400,
      `Filtering on "${parsed.attribute}" is not supported. ${hint}`,
      "invalidFilter",
    );
  }
  return parsed;
};
