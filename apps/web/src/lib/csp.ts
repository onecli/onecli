/**
 * Content-Security-Policy for the cloud dashboard (OC-01).
 *
 * The CSP moved from a static CloudFront ResponseHeadersPolicy row into the
 * app so `script-src` can drop `'unsafe-inline'` / `'unsafe-eval'` in favor
 * of a per-request nonce: Next.js reads the request's CSP header during SSR
 * and stamps the nonce onto every framework, chunk, and inline script it
 * emits — something a static edge header can never do. `proxy.ts` generates
 * the nonce, threads it to the layout via `x-nonce`, and mirrors the header
 * onto the response; the CloudFront policy no longer carries a CSP row.
 *
 * Env access is a literal dot read at call time (the public-origins rules):
 * Next.js can only inline `NEXT_PUBLIC_*` literals, and tests stub env per
 * case with no module dance.
 */
import { apiOrigin, gatewayHttpOrigin } from "@onecli/api/lib/public-origins";

/** 128-bit random nonce, base64 — regenerated for every request. */
export const createCspNonce = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
};

/**
 * The full policy, one nonce per request. Every directive except
 * `script-src` is byte-equivalent to the retired CloudFront row; the
 * api/auth hosts are resolved instead of hardcoded so dev and prod both get
 * their own domains.
 */
export const buildCsp = (nonce: string): string => {
  // React needs eval only under `next dev` (it reconstructs server error
  // stacks in the browser); production drops it entirely — neither React nor
  // Next.js uses eval in a production build.
  const isDev = process.env.NODE_ENV === "development";

  // CSP3 browsers enforce the nonce + 'strict-dynamic' and ignore the host
  // allowlist; the hosts stay as the fallback for older CSP2 browsers, so no
  // browser gets a weaker policy than the pre-nonce one ('unsafe-inline'
  // aside — dropping it is the point).
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDev ? ["'unsafe-eval'"] : []),
    "https://js.stripe.com",
    "https://t.1cli.sh",
    "https://cdn.usefathom.com",
  ];

  // Bare Cognito hosted-UI domain (e.g. auth.onecli.sh) — the same value
  // amplify-config hands to Amplify's oauth.domain.
  const cognitoDomain =
    process.env.COGNITO_DOMAIN?.trim() ||
    process.env.NEXT_PUBLIC_COGNITO_DOMAIN?.trim();

  const connectSrc = [
    "'self'",
    // One entry when the gateway rides the api origin (cloud does).
    ...new Set([apiOrigin(), gatewayHttpOrigin()]),
    ...(cognitoDomain ? [`https://${cognitoDomain}`] : []),
    "https://*.amazoncognito.com",
    "https://*.auth.us-east-1.amazoncognito.com",
    "https://cognito-idp.us-east-1.amazonaws.com",
    "https://api.stripe.com",
    "https://t.1cli.sh",
    "https://cdn.usefathom.com",
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    `connect-src ${connectSrc.join(" ")}`,
    "frame-src https://js.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
};
