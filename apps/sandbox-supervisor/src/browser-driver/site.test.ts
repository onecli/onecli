import { describe, expect, it } from "vitest";
import { hostOf, onSite, siteOf } from "./site";

describe("the same-site rule", () => {
  const same = (page: string, other: string) =>
    onSite(hostOf(other), siteOf(hostOf(page)));

  it("takes three labels under a country code with a short second level", () => {
    // The bug this pins: the last two labels made every .co.il host one
    // site, so ynet kept the ads of every other Israeli site.
    expect(siteOf("www.ynet.co.il")).toBe("ynet.co.il");
    expect(siteOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("www.abc.com.au")).toBe("abc.com.au");
    expect(same("https://www.ynet.co.il/", "https://cz.ynet.co.il/x")).toBe(
      true,
    );
    expect(same("https://www.ynet.co.il/", "https://rep.erate.co.il/")).toBe(
      false,
    );
    expect(same("https://www.abc.com.au/", "https://xyz.com.au/")).toBe(false);
  });

  it("takes two labels otherwise, apex included, never a lookalike", () => {
    expect(siteOf("search.google.com")).toBe("google.com");
    expect(siteOf("example.com")).toBe("example.com");
    expect(same("https://www.example.com/", "https://example.com/e")).toBe(
      true,
    );
    expect(same("https://example.com/", "https://cdn.example.com/x")).toBe(
      true,
    );
    expect(same("https://www.example.com/", "https://evil-example.com/")).toBe(
      false,
    );
    expect(same("https://www.example.com/", "https://other.com/")).toBe(false);
  });

  it("keeps an address or a single label whole, and refuses what does not parse", () => {
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("[::1]")).toBe("[::1]");
    expect(siteOf("localhost")).toBe("localhost");
    expect(same("http://127.0.0.1:8080/", "http://127.0.0.1:9000/api")).toBe(
      true,
    );
    expect(same("http://10.0.0.1/", "http://20.0.0.1/")).toBe(false);
    expect(hostOf("not a url")).toBe("");
    expect(same("https://example.com/", "about:blank")).toBe(false);
  });
});
