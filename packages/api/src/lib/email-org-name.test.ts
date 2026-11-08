import { describe, expect, it } from "vitest";
import { isPublicEmailDomain, orgNameFromEmail } from "./email-org-name";

describe("orgNameFromEmail", () => {
  it("names a company address's org after the company, without the ending", () => {
    expect(orgNameFromEmail("dana@acme.com")).toBe("acme");
    expect(orgNameFromEmail("Dana@ACME.io")).toBe("acme");
    expect(orgNameFromEmail("dana@acme-labs.co.uk")).toBe("acme-labs");
    expect(orgNameFromEmail("dana@acme.com.au")).toBe("acme");
    expect(orgNameFromEmail("dana@eu.acme.com")).toBe("acme");
  });

  it("reads every country's endings from the Public Suffix List", () => {
    expect(orgNameFromEmail("dana@acme.ne.jp")).toBe("acme");
    expect(orgNameFromEmail("dana@acme.or.jp")).toBe("acme");
    expect(orgNameFromEmail("dana@acme.ind.br")).toBe("acme");
    expect(orgNameFromEmail("dana@acme.com.")).toBe("acme");
  });

  it("names a shared mailbox's org after the person, never the provider", () => {
    expect(orgNameFromEmail("dana.cohen@gmail.com")).toBe("dana.cohen");
    expect(orgNameFromEmail("dana@hotmail.com")).toBe("dana");
    expect(orgNameFromEmail("dana@outlook.com")).toBe("dana");
    expect(orgNameFromEmail("dana@yahoo.com")).toBe("dana");
    expect(orgNameFromEmail("dana@icloud.com")).toBe("dana");
  });

  it("treats a provider's regional variants as shared too", () => {
    expect(orgNameFromEmail("dana@hotmail.co.uk")).toBe("dana");
    expect(orgNameFromEmail("dana@yahoo.co.jp")).toBe("dana");
    expect(orgNameFromEmail("dana@gmx.de")).toBe("dana");
    expect(orgNameFromEmail("dana@mail.ru")).toBe("dana");
  });

  it("returns null when nothing is usable, so the caller's fallback wins", () => {
    expect(orgNameFromEmail("not-an-email")).toBeNull();
    expect(orgNameFromEmail("@gmail.com")).toBeNull();
    expect(orgNameFromEmail("@localhost")).toBeNull();
  });

  it("falls back to the person when the domain has no registrable part", () => {
    expect(orgNameFromEmail("dana@localhost")).toBe("dana");
    expect(orgNameFromEmail("dana@127.0.0.1")).toBe("dana");
  });
});

describe("isPublicEmailDomain", () => {
  it("still refuses every provider the verified-domain check always refused", () => {
    // A verified domain grants org-level trust over every address on it:
    // the check may grow stricter, never looser.
    for (const domain of [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "live.com",
      "msn.com",
      "yahoo.com",
      "ymail.com",
      "icloud.com",
      "me.com",
      "mac.com",
      "aol.com",
      "proton.me",
      "protonmail.com",
      "pm.me",
      "gmx.com",
      "gmx.net",
      "mail.com",
      "zoho.com",
      "yandex.com",
      "yandex.ru",
      "fastmail.com",
      "hey.com",
      "tutanota.com",
      "tuta.io",
    ]) {
      expect(isPublicEmailDomain(domain)).toBe(true);
    }
  });

  it("knows the providers and their regional variants", () => {
    expect(isPublicEmailDomain("gmail.com")).toBe(true);
    expect(isPublicEmailDomain("outlook.co.il")).toBe(true);
    expect(isPublicEmailDomain("mail.com")).toBe(true);
    expect(isPublicEmailDomain("acme.com")).toBe(false);
  });

  it("never mistakes a company subdomain for a provider of the same name", () => {
    for (const domain of [
      "mail.acme.com",
      "me.acme.com",
      "live.acme.com",
      "pm.acme.com",
      "hey.acme.io",
    ]) {
      expect(isPublicEmailDomain(domain)).toBe(false);
    }
  });

  it("leaves a company's own domain on a generic word claimable", () => {
    for (const domain of ["hey.app", "live.io", "me.dev", "proton.ai"]) {
      expect(isPublicEmailDomain(domain)).toBe(false);
    }
    expect(orgNameFromEmail("dana@hey.app")).toBe("hey");
  });
});
