/**
 * Loads Cloudflare Turnstile's browser API once per page, on demand.
 *
 * https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
 *
 * The script must come from Cloudflare's exact URL (proxying or caching it
 * breaks Turnstile when Cloudflare ships updates), and `render=explicit`
 * stops it from scanning the page: the login form renders its widget itself
 * with `turnstile.render()`. Under the dashboard's nonce-based CSP the
 * script is trusted through `'strict-dynamic'` (it is inserted by an already
 * trusted script); the page nonce is copied onto it as well, which is how
 * Cloudflare propagates the nonce to whatever the widget loads next.
 */

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<Turnstile.Turnstile> | undefined;

const loaded = (): Turnstile.Turnstile | undefined =>
  typeof turnstile === "undefined" ? undefined : turnstile;

/** The nonce of the current page, from any script Next.js stamped. */
const pageNonce = (): string | undefined =>
  document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ||
  undefined;

/**
 * Resolves with the Turnstile API. A failed load (blocked by an extension or
 * the network) rejects, and the next call tries again.
 */
export const loadTurnstile = (): Promise<Turnstile.Turnstile> => {
  const ready = loaded();
  if (ready) return Promise.resolve(ready);

  loading ??= new Promise<Turnstile.Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    const nonce = pageNonce();
    if (nonce) script.nonce = nonce;

    const fail = () => {
      script.remove();
      loading = undefined;
      reject(new Error("Turnstile failed to load"));
    };
    script.onload = () => {
      const api = loaded();
      if (api) resolve(api);
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
};
