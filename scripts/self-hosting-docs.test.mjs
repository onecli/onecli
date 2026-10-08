// The reverse-proxy configs in docs/self-hosting.md, pinned to the code they
// route.
//
// In proxy mode one origin fronts three services, and `/auth` is shared: the
// api-server serves better-auth under it while the dashboard serves its own
// sign-in pages there. The docs' Caddy and nginx examples carry a hand-written
// copy of that page list. If a new `/auth/<page>` ships without a docs update,
// self-hosts copying the example get a 404 on that page, the way the original
// example 404'd every sign-in page. This file fails first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const DOC = read("docs/self-hosting.md");
const API_SERVER = read("apps/api-server/src/app.ts");

const fence = (lang) => {
  const match = DOC.match(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```"));
  assert.ok(match, `docs/self-hosting.md has no \`\`\`${lang} block`);
  return match[1];
};
const CADDY = fence("caddy");
const NGINX = fence("nginx");

const WEB = 10254;
const API = 10256;

// Every route the dashboard's filesystem router serves under /auth.
const collectPages = (dir, route) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectPages(full, `${route}/${entry}`));
    } else if (entry === "page.tsx") {
      out.push(route);
    }
  }
  return out;
};
const WEB_AUTH_PAGES = collectPages(
  join(REPO, "apps/web/src/app/auth"),
  "/auth",
);

// ── Caddy ────────────────────────────────────────────────────────────────
// A minimal model of the doc's Caddyfile: the dashboard matcher's paths and
// methods, plus which upstream each `handle`/`handle_path` block sends to.

const caddyMatcher = CADDY.match(/@dashboard_auth\s*\{([\s\S]*?)\n\s*\}/);
const caddyPaths =
  caddyMatcher?.[1]
    .match(/^\s*path\s+(.+)$/m)?.[1]
    .trim()
    .split(/\s+/) ?? [];
const caddyMethods =
  caddyMatcher?.[1]
    .match(/^\s*method\s+(.+)$/m)?.[1]
    .trim()
    .split(/\s+/) ?? [];

// Caddy path matching: exact, or a trailing `*` prefix.
const caddyPathMatches = (pattern, path) =>
  pattern.endsWith("*")
    ? path.startsWith(pattern.slice(0, -1))
    : path === pattern;

const caddyUpstream = (prefix) => {
  const block = CADDY.match(
    new RegExp(
      `handle(?:_path)?\\s+${prefix.replace(/[/*]/g, "\\$&")}\\s*\\{\\s*reverse_proxy\\s+127\\.0\\.0\\.1:(\\d+)`,
    ),
  );
  return block ? Number(block[1]) : undefined;
};

test("caddy: the dashboard matcher covers exactly the dashboard's /auth pages", () => {
  assert.ok(caddyMatcher, "the Caddy example lost its @dashboard_auth matcher");
  for (const page of WEB_AUTH_PAGES) {
    assert.ok(
      caddyPaths.some((p) => caddyPathMatches(p, page)),
      `${page} is a dashboard page but the Caddy @dashboard_auth matcher ` +
        "does not cover it; the example would send it to the api (a 404)",
    );
  }
  for (const pattern of caddyPaths) {
    assert.ok(
      WEB_AUTH_PAGES.some((page) => caddyPathMatches(pattern, page)),
      `${pattern} is in the Caddy matcher but no dashboard page serves it`,
    );
  }
});

test("caddy: the dashboard matcher is by path only and comes before the api's /auth", () => {
  // The dashboard forwards the reset form's POST to the api itself (the web
  // proxy's apiFormSubmitOnPagePath), so the example needs no method rule.
  // A method rule here would be a regression: Ingress-style routers cannot
  // express one, and the docs must show the shape every edge can copy.
  assert.deepEqual(caddyMethods, [], "the Caddy matcher grew a method rule");
  const matcherAt = CADDY.indexOf("handle @dashboard_auth");
  assert.ok(matcherAt >= 0, "@dashboard_auth is defined but never handled");
  assert.ok(
    matcherAt < CADDY.indexOf("handle /auth/*"),
    "handle @dashboard_auth must come before handle /auth/*",
  );
  assert.equal(
    CADDY.match(
      /handle @dashboard_auth\s*\{\s*reverse_proxy\s+127\.0\.0\.1:(\d+)/,
    )?.[1],
    String(WEB),
  );
});

// ── nginx ────────────────────────────────────────────────────────────────

const nginxCarveOut = NGINX.match(
  /location ~ (\^\/auth\/\S+\$) \{([\s\S]*?)\n {4}\}/,
);

test("nginx: the dashboard carve-out covers exactly the dashboard's /auth pages", () => {
  assert.ok(
    nginxCarveOut,
    "the nginx example lost its /auth page regex location",
  );
  const re = new RegExp(nginxCarveOut[1]);
  for (const page of WEB_AUTH_PAGES) {
    assert.ok(
      re.test(page),
      `${page} is a dashboard page but the nginx regex misses it`,
    );
  }
  // The api's own endpoints must NOT be pulled into the carve-out.
  for (const apiPath of [
    "/auth/get-session",
    "/auth/sign-in/email",
    "/auth/callback/google",
    "/auth/reset-password/tok",
  ]) {
    assert.ok(
      !re.test(apiPath),
      `${apiPath} is an api endpoint but the nginx regex captures it`,
    );
  }
});

test("nginx: the dashboard carve-out is by path only, every method to the dashboard", () => {
  const body = nginxCarveOut[2];
  assert.doesNotMatch(
    body,
    /\$request_method/,
    "the nginx carve-out grew a method rule (the dashboard forwards submits itself)",
  );
  assert.match(body, new RegExp(`proxy_pass http://127\\.0\\.0\\.1:${WEB};`));
  assert.doesNotMatch(body, new RegExp(`127\\.0\\.0\\.1:${API}`));
});

// ── the forward both examples now rely on ────────────────────────────────

test("the dashboard forwards non-page-load methods on its page paths to the api", () => {
  // The examples above are only correct because proxy.ts rewrites a POST on
  // a dashboard page path to the api. Pin the two sides together: should the
  // forward go, this test fails before a self-host copies a broken example.
  const PROXY = read("apps/web/src/proxy.ts");
  assert.match(PROXY, /const apiFormSubmitOnPagePath = /);
  assert.match(PROXY, /NextResponse\.rewrite\(apiTarget\)/);
  assert.match(PROXY, /getApiInternalUrl\(\)/);
  // And compose hands the dashboard the in-network api address it needs.
  const COMPOSE = read("docker/docker-compose.yml");
  assert.match(COMPOSE, /API_INTERNAL_URL: http:\/\/api:10256/);
});

test("nginx: serves HTTP/2 (HTTP/1.1 sends the sign-in pages into a session-fetch burst)", () => {
  // Measured against v2.7.0: over HTTP/1.1 one load of /auth/login issued
  // ~170 GET /auth/get-session in four seconds and hit the api's rate limit;
  // over HTTP/2, one. Caddy negotiates HTTP/2 by default, nginx does not.
  assert.match(NGINX, /^\s*http2 on;$/m);
});

test("nginx: X-Forwarded-For is overwritten, never appended", () => {
  // The api's rate limiters key on it. Measured against v2.7.0 with
  // $proxy_add_x_forwarded_for and a forged header: better-auth saw two
  // entries, resolved no IP and fell back to one bucket shared by every
  // caller; the Redis-backed limiter reads the leftmost (client-chosen) entry.
  assert.match(NGINX, /^\s*proxy_set_header X-Forwarded-For \$remote_addr;$/m);
  assert.doesNotMatch(NGINX, /\$proxy_add_x_forwarded_for/);
});

// ── both ────────────────────────────────────────────────────────────────
// Every outer-root surface the api-server mounts must be routed to it.

const apiMounts = () => {
  const mounts = new Set(["/v1"]); // apiApp's basePath
  for (const m of API_SERVER.matchAll(/app\.route\("(\/[^"]+)"/g))
    mounts.add(m[1]);
  if (/BETTER_AUTH_BASE_PATH\}\/\*/.test(API_SERVER)) mounts.add("/auth");
  return [...mounts];
};

test("both configs route every api-server mount to the api", () => {
  const mounts = apiMounts();
  assert.ok(
    mounts.includes("/scim/v2"),
    "expected the SCIM mount in apps/api-server/src/app.ts",
  );
  for (const mount of mounts) {
    assert.equal(
      caddyUpstream(`${mount}/*`),
      API,
      `Caddy does not route ${mount}/* to the api`,
    );
    assert.match(
      NGINX,
      new RegExp(
        `location ${mount.replace(/\//g, "\\/")}\\/ \\{ proxy_pass http://127\\.0\\.0\\.1:${API};`,
      ),
      `nginx does not route ${mount}/ to the api`,
    );
  }
});
