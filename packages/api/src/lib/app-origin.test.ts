import { afterEach, describe, expect, it } from "vitest";
import { configuredAppUrl, originFromHeaders } from "./app-origin";

describe("configuredAppUrl", () => {
  const orig = {
    APP_URL: process.env.APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  afterEach(() => {
    for (const key of ["APP_URL", "NEXT_PUBLIC_APP_URL"] as const) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });

  // The load-bearing case: `undefined` is what lets call sites fall back to the
  // request origin. If this ever returned the lib/env.ts default instead, every
  // consumer would silently pin self-hosters to localhost again.
  it("is undefined when nothing is configured", () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(configuredAppUrl()).toBeUndefined();
  });

  it("treats empty and whitespace-only values as unconfigured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.APP_URL = "";
    expect(configuredAppUrl()).toBeUndefined();
    process.env.APP_URL = "   ";
    expect(configuredAppUrl()).toBeUndefined();
  });

  it("returns a configured URL with trailing slashes stripped", () => {
    process.env.APP_URL = "https://onecli.example.com//";
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(configuredAppUrl()).toBe("https://onecli.example.com");
  });

  it("falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset", () => {
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://public.example.com";
    expect(configuredAppUrl()).toBe("https://public.example.com");
  });

  // An APP_URL that is present but blank must not shadow a real
  // NEXT_PUBLIC_APP_URL — otherwise a stray `APP_URL=` line silently wins.
  it("skips a blank APP_URL in favor of NEXT_PUBLIC_APP_URL", () => {
    process.env.APP_URL = "";
    process.env.NEXT_PUBLIC_APP_URL = "https://public.example.com";
    expect(configuredAppUrl()).toBe("https://public.example.com");
  });
});

describe("originFromHeaders", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("prefers x-forwarded-host with x-forwarded-proto", () => {
    expect(
      originFromHeaders(
        headers({
          "x-forwarded-host": "proxy.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://proxy.example.com");
  });

  it("takes the first entry of comma-separated proxy chains", () => {
    expect(
      originFromHeaders(
        headers({
          "x-forwarded-host": "edge.example.com, inner.example.com",
          "x-forwarded-proto": "https, http",
        }),
      ),
    ).toBe("https://edge.example.com");
  });

  it("defaults a forwarded host with no forwarded proto to http", () => {
    expect(
      originFromHeaders(headers({ "x-forwarded-host": "proxy.local" })),
    ).toBe("http://proxy.local");
  });

  it("falls back to the Host header", () => {
    expect(originFromHeaders(headers({ host: "box.local:10254" }))).toBe(
      "http://box.local:10254",
    );
  });

  it("applies fallbackProto only on the Host path", () => {
    expect(originFromHeaders(headers({ host: "box.local" }), "https")).toBe(
      "https://box.local",
    );
    // A forwarded host ignores fallbackProto — preserved legacy behavior.
    expect(
      originFromHeaders(
        headers({ "x-forwarded-host": "proxy.local" }),
        "https",
      ),
    ).toBe("http://proxy.local");
  });

  it("lets x-forwarded-proto win over fallbackProto on the Host path", () => {
    expect(
      originFromHeaders(
        headers({ host: "box.local", "x-forwarded-proto": "https" }),
        "http",
      ),
    ).toBe("https://box.local");
  });

  it("is undefined when no host header is present", () => {
    expect(originFromHeaders(headers({}))).toBeUndefined();
  });

  // These origins reach `Location` headers and, on the OAuth fragment-bridge
  // path, the inside of a <script> block that escapes with JSON.stringify —
  // which does not neutralize "</script>". Rejecting non-host characters here
  // closes that sink for every consumer at once.
  it("rejects hosts that aren't syntactically hosts", () => {
    for (const bad of [
      "evil</script><script>alert(1)</script>",
      'evil"+alert(1)+"',
      "evil com",
      "evil/path",
      "evil?x=1",
    ]) {
      expect(originFromHeaders(headers({ host: bad }))).toBeUndefined();
      expect(
        originFromHeaders(headers({ "x-forwarded-host": bad })),
      ).toBeUndefined();
    }
  });

  it("accepts ports and IP literals", () => {
    expect(originFromHeaders(headers({ host: "192.168.1.5:10254" }))).toBe(
      "http://192.168.1.5:10254",
    );
    expect(originFromHeaders(headers({ host: "[::1]:10254" }))).toBe(
      "http://[::1]:10254",
    );
  });

  it("ignores a non-http(s) forwarded proto", () => {
    expect(
      originFromHeaders(
        headers({ host: "box.local", "x-forwarded-proto": "javascript" }),
      ),
    ).toBe("http://box.local");
  });

  // The one intentional departure from the logic this replaced, which returned
  // a hostless "http://" here. Falling through keeps a misconfigured proxy from
  // producing a redirect target that goes nowhere.
  it("falls through to Host when x-forwarded-host is blank", () => {
    expect(
      originFromHeaders(
        headers({ "x-forwarded-host": "   ", host: "box.local" }),
      ),
    ).toBe("http://box.local");
    expect(
      originFromHeaders(headers({ "x-forwarded-host": "   " })),
    ).toBeUndefined();
  });
});
