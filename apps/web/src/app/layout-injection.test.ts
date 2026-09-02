import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source-as-assertion pins (the proxy.test.ts style) for the runtime URL
// delivery mechanism the whole self-host addressing design leans on. The
// layout renders per request and hands the browser its API/gateway origins;
// if any of these load-bearing properties drift, tunneled and prebuilt-image
// deployments break in ways no unit of the layout itself would catch.
const source = readFileSync(join(__dirname, "layout.tsx"), "utf8");

describe("root layout browser-origin injection", () => {
  it("stays force-dynamic — a prebuilt page must never bake the origins", () => {
    expect(source).toContain('export const dynamic = "force-dynamic"');
  });

  it("dev branch injects the page's own origin (+/gw), tunnel-proof", () => {
    expect(source).toContain(
      'window.__GATEWAY_API_URL__=location.origin+"/gw";window.__API_URL__=location.origin',
    );
  });

  it("prod branch injects the resolver's origins per request", () => {
    expect(source).toMatch(
      /window\.__GATEWAY_API_URL__=\$\{JSON\.stringify\(gatewayHttpOrigin\(\)\)\};window\.__API_URL__=\$\{JSON\.stringify\(apiOrigin\(\)\)\}/,
    );
    expect(source).toContain('from "@onecli/api/lib/public-origins"');
  });

  it("injection is gated to self-host — cloud trusts the build-time bakes", () => {
    expect(source).toContain("{!IS_CLOUD && (");
  });
});

describe("root layout CSP nonce (OC-01)", () => {
  it("reads the nonce proxy.ts forwards on x-nonce", () => {
    expect(source).toContain('(await headers()).get("x-nonce")');
  });

  it("passes it to next-themes — its inline theme script needs the attr", () => {
    expect(source).toMatch(/<ThemeProvider[^>]*(\n\s+[^>\n]+)*\n\s+nonce=/);
  });

  it("stamps the self-host origin script — inert today, ready for an onprem CSP", () => {
    expect(source).toMatch(/<script\s*\n\s+nonce=\{nonce\}/);
  });
});
