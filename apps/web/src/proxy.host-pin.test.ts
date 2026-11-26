/**
 * The local-dashboard Host pin (proxy.ts, `WEB_DEV_PINNED_HOST`).
 *
 * `pnpm web:dev` runs this dashboard on a laptop against a remote dev
 * deployment, holding that deployment's database login. A few pages read
 * the database before any session exists, so a DNS-rebinding page (its own
 * hostname, resolving to the laptop) must not reach them. The launcher pins
 * the one Host the developer browses to; unset, nothing changes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const request = (host: string, path = "/join?token=abc") =>
  new NextRequest(`http://${host}${path}`, { headers: { host } });

afterEach(() => {
  delete process.env.WEB_DEV_PINNED_HOST;
});

describe("the local dashboard's Host pin", () => {
  it("refuses any other Host when pinned, before any page or api route runs", () => {
    process.env.WEB_DEV_PINNED_HOST = "localhost:10254";
    for (const host of [
      "evil.example:10254",
      "127.0.0.1:10254",
      "localhost:10255",
      "localhost",
    ]) {
      const response = proxy(request(host));
      expect(response.status, host).toBe(421);
    }
    expect(proxy(request("evil.example:10254", "/v1/agents")).status).toBe(421);
  });

  it("lets the pinned Host through", () => {
    process.env.WEB_DEV_PINNED_HOST = "localhost:10254";
    expect(proxy(request("localhost:10254")).status).not.toBe(421);
  });

  it("does nothing when unset (every deployed dashboard)", () => {
    expect(proxy(request("evil.example:10254")).status).not.toBe(421);
  });
});
