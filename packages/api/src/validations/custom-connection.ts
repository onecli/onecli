import { parse } from "tldts";
import { z } from "zod";
import {
  cleanLabel,
  isFormatChar,
  MAX_CUSTOM_CONNECTION_LABEL_CHARS,
} from "@onecli/agent-protocol/text";
import { hostPatternSchema } from "./secret";

/**
 * An agent's PROPOSAL for a custom (generic secret) connection — the
 * `propose_custom_connection` platform tool's arguments and the immutable
 * `ActionApproval.payload` of a `secret.create_custom` hold.
 *
 * There is deliberately NO field for the credential: the key only ever
 * travels from the human's approve card to the dedicated approve route, in
 * memory. `.strict()` makes an extra `value`/`key` argument a refusal rather
 * than something silently persisted in the payload or the tool event.
 *
 * Shape-only (pure, browser-safe imports). The host POLICY that needs the
 * catalog and the deployment's own origins (`custom-connection-policy.ts`)
 * runs beside it, at propose time and again at approve time.
 */

/** The action key of an agent-proposed custom connection hold. */
export const CUSTOM_CONNECTION_ACTION = "secret.create_custom";

const MAX_HEADER_NAME_CHARS = 64;
const MAX_VALUE_FORMAT_CHARS = 500;
const MAX_PROPOSAL_REASON_CHARS = 500;
const MAX_PROPOSAL_DOCS_URL_CHARS = 2000;
const MAX_PROPOSAL_PATH_CHARS = 500;

/** RFC 9110 `token`: the only characters a header field name may hold. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Headers a proposal may never set: framing and hop-by-hop headers (request
 * smuggling / routing), cookies (session riding), and the gateway's own
 * namespaces. `authorization` is deliberately ALLOWED: it is the most common
 * place an API key goes.
 */
const DENIED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "cookie",
  "set-cookie",
]);
const DENIED_HEADER_PREFIXES = ["proxy-", "x-onecli-"];

export const isDeniedHeaderName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return (
    DENIED_HEADERS.has(lower) ||
    DENIED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
};

/**
 * Any C0/C1 control, DEL, Unicode line/paragraph separator, or an invisible
 * format character (bidi overrides, zero-width): anything that could make
 * the card show something other than what is sent.
 */
const hasControlChars = (v: string): boolean =>
  [...v].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      isFormatChar(code)
    );
  });

/**
 * ASCII letters, digits, hyphens and dots, with an optional whole-label
 * leading `*.`. Rules out look-alike Unicode hosts on the approval card;
 * internationalized domains must be proposed in their xn-- form.
 */
const ASCII_HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const labelSchema = (max: number) =>
  z
    .string()
    .transform((v) => cleanLabel(v, max))
    .pipe(z.string().min(1, "Name is required"));

/** The literal labels after any leading wildcard labels (`*.a.b` -> `a.b`). */
const literalTail = (hostPattern: string): string =>
  hostPattern
    .split(".")
    .filter((label) => label !== "*")
    .join(".");

/**
 * The registrable domain a host pattern lands in ("api.acmecrm.io" and
 * "*.acmecrm.io" -> "acmecrm.io"), or null when the pattern is not under a
 * known public suffix: an IP literal, `localhost`, `*.internal`, or a
 * special-use name (RFC 6761: `.home.arpa`, `.onion`, `.test`, `.local`,
 * ...), some of which the Public Suffix List carries as ordinary suffixes.
 * The approve card highlights it: it is the owner the key is sent to.
 *
 * The input is already a hostname, so tldts's own URL-ish extraction is off
 * (its README's advice for security decisions).
 */
export const registrableDomainOf = (hostPattern: string): string | null => {
  const tail = literalTail(hostPattern.trim().toLowerCase());
  const parsed = parse(tail, {
    allowPrivateDomains: true,
    detectSpecialUse: true,
    extractHostname: false,
  });
  if (parsed.isIp || parsed.isSpecialUse === true) return null;
  if (parsed.isIcann !== true && parsed.isPrivate !== true) return null;
  return parsed.domain;
};

const looksLikeIpLiteral = (hostPattern: string): boolean => {
  const tail = literalTail(hostPattern);
  return (
    tail.includes(":") ||
    tail.includes("[") ||
    /^[0-9.]+$/.test(tail) ||
    /^0x/i.test(tail) ||
    parse(tail).isIp === true
  );
};

export const customConnectionProposalSchema = z
  .object({
    name: labelSchema(MAX_CUSTOM_CONNECTION_LABEL_CHARS),
    hostPattern: hostPatternSchema
      .transform((v) => v.toLowerCase())
      .refine((v) => ASCII_HOST_PATTERN.test(v), {
        message:
          "Use a plain ASCII hostname (letters, digits, hyphens, dots, optional leading *.).",
      })
      .refine((v) => !looksLikeIpLiteral(v), {
        message: "Use the service's hostname, not an IP address.",
      })
      .refine((v) => registrableDomainOf(v) !== null, {
        message:
          "The host must be a public internet domain (no localhost, internal, or private names).",
      }),
    pathPattern: z
      .string()
      .trim()
      .max(MAX_PROPOSAL_PATH_CHARS)
      .refine((v) => v.startsWith("/"), {
        message: "pathPattern must start with /",
      })
      .refine((v) => !/\s/.test(v) && !hasControlChars(v), {
        message: "pathPattern must not contain spaces or control characters",
      })
      .optional(),
    headerName: z
      .string()
      .trim()
      .min(1, "headerName is required")
      .max(MAX_HEADER_NAME_CHARS)
      .refine((v) => HEADER_TOKEN.test(v), {
        message: "headerName must be a valid HTTP header name",
      })
      .refine((v) => !isDeniedHeaderName(v), {
        message:
          "That header can't carry a credential (framing, cookie, proxy and x-onecli-* headers are reserved).",
      }),
    valueFormat: z
      .string()
      .max(MAX_VALUE_FORMAT_CHARS)
      .refine((v) => v.split("{value}").length === 2, {
        message:
          'valueFormat must contain "{value}" exactly once (e.g. "Bearer {value}")',
      })
      .refine((v) => !hasControlChars(v), {
        message:
          "valueFormat must not contain line breaks or control characters",
      })
      // HTTP Basic would make the person base64-encode "id:secret" by hand
      // into the one key field. Not supported for proposals yet: refuse it
      // so the agent tells the user instead of handing them an encoding job.
      .refine((v) => !/^\s*basic\s/i.test(v), {
        message:
          "HTTP Basic auth isn't supported for custom connections yet. Tell the user this API needs Basic auth and that they can't connect it this way for now; never ask them to encode or combine credentials.",
      }),
    docsUrl: z
      .string()
      .trim()
      .max(MAX_PROPOSAL_DOCS_URL_CHARS)
      .refine(
        (v) => {
          try {
            return new URL(v).protocol === "https:";
          } catch {
            return false;
          }
        },
        { message: "docsUrl must be an https URL" },
      )
      .optional(),
    reason: z
      .string()
      .max(MAX_PROPOSAL_REASON_CHARS * 2)
      .transform((v) => cleanLabel(v, MAX_PROPOSAL_REASON_CHARS))
      .pipe(z.string().min(1, "reason is required")),
  })
  .strict();

export type CustomConnectionProposal = z.infer<
  typeof customConnectionProposalSchema
>;

/** The approve route's body: the key, and only the key. */
export const customConnectionApproveSchema = z
  .object({
    value: z
      .string()
      .max(10000)
      .refine((v) => v.trim().length > 0, { message: "Enter the API key" })
      .refine((v) => !/[\r\n]/.test(v.trim()), {
        message: "The key must be a single line",
      }),
  })
  .strict();
