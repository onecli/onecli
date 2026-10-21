/**
 * Content-Security-Policy for the cloud dashboard (OC-01).
 *
 * The CSP lives in the app (not a static edge header) so `script-src` can
 * drop `'unsafe-inline'` / `'unsafe-eval'` in favor
 * of a per-request nonce: Next.js reads the request's CSP header during SSR
 * and stamps the nonce onto every framework, chunk, and inline script it
 * emits — something a static edge header can never do. `proxy.ts` generates
 * the nonce, threads it to the layout via `x-nonce`, and mirrors the header
 * onto the response.
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
 * `script-src` is byte-equivalent to the previous static policy; the
 * api/auth hosts are resolved instead of hardcoded so dev and prod both get
 * their own domains.
 */
export const buildCsp = (nonce: string): string => {
  // React needs eval only under `next dev` (it reconstructs server error
  // stacks in the browser); production drops it entirely — neither React nor
  // Next.js uses eval in a production build.
  const isDev = process.env.NODE_ENV === "development";

  // Human verification on the signup form (Cloudflare Turnstile): its script
  // and its challenge iframe both come from this origin. Only when a sitekey
  // is configured, so a deployment without the widget keeps the narrower
  // policy. Literal read: Next.js inlines NEXT_PUBLIC_* into the build.
  const turnstileOrigin = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()
    ? ["https://challenges.cloudflare.com"]
    : [];

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
    ...turnstileOrigin,
  ];

  // Bare Cognito hosted-UI domain (e.g. auth.onecli.sh) — the same value
  // amplify-config hands to Amplify's oauth.domain.
  const cognitoDomain =
    process.env.COGNITO_DOMAIN?.trim() ||
    process.env.NEXT_PUBLIC_COGNITO_DOMAIN?.trim();

  // The sandbox preview zone: the agent's screen streams over a WebSocket
  // straight to `wss://<share>.<zone>`, so the zone's hosts must be
  // connectable. `wss:` only (a page there is still a navigation, never a
  // fetch from here), and only the zone the deployment configures.
  // Absent = dark.
  const previewDomain = process.env.PREVIEW_DOMAIN?.trim().toLowerCase();
  const previewZone =
    previewDomain && /^[a-z0-9.-]+$/.test(previewDomain)
      ? [`wss://*.${previewDomain}`]
      : [];

  const connectSrc = [
    "'self'",
    // One entry when the gateway rides the api origin (cloud does).
    ...new Set([apiOrigin(), gatewayHttpOrigin()]),
    ...(cognitoDomain ? [`https://${cognitoDomain}`] : []),
    ...previewZone,
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
    `frame-src ${["https://js.stripe.com", ...turnstileOrigin].join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
};
