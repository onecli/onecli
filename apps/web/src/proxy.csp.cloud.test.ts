/**
 * Cloud nonce CSP (OC-01), proven on the proxy's actual output. The policy
 * CONTENT is unit-tested in lib/csp.test.ts; this pins the wiring: the CSP
 * rides the FORWARDED REQUEST (what makes Next nonce its scripts), the
 * response carries the same policy for the browser to enforce, server
 * components get the nonce via x-nonce, and a client-supplied x-nonce never
 * survives. `IS_CLOUD` freezes at module load, hence the hoisted pin.
 */

import { vi, describe, expect, it } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("cloud: per-request nonce CSP", () => {
  it("forwards and enforces one CSP carrying a freshly minted nonce, never the client's", () => {
    const response = proxy(
      new NextRequest("https://app.onecli.sh/w/ws-1/overview", {
        headers: { "x-nonce": "attacker" },
      }),
    );
    const csp = response.headers.get("content-security-policy");
    const nonce = response.headers.get("x-middleware-request-x-nonce");

    expect(csp).toBeTruthy();
    expect(
      response.headers.get("x-middleware-request-content-security-policy"),
    ).toBe(csp);
    expect(nonce).toBeTruthy();
    expect(nonce).not.toBe("attacker");
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).not.toContain("attacker");
  });
});
