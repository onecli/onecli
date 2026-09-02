import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The self-host provisioners mint the terminator's host key with a
 * hand-rolled openssh-key-v1 encoder (scripts/lib/openssh-key.mjs) because
 * ssh2 — the library this terminator hands the host key to — rejects the
 * PKCS#8 ed25519 PEM that node:crypto emits directly. This is the
 * cross-check that the encoder's output actually parses with the exact ssh2
 * the terminator depends on. It lives here (not in the scripts test) because
 * ssh2 is this app's dependency, not the repo root's.
 */

const require = createRequire(import.meta.url);
const { utils } = require("ssh2") as {
  utils: { parseKey(pem: string): unknown };
};

describe("provisioner host key ↔ ssh2", () => {
  it("the minted openssh-key-v1 host key parses as ssh-ed25519", async () => {
    // Computed specifier: the .mjs ships no .d.ts, so a literal import trips
    // noImplicitAny — resolve it dynamically and narrow the one member used.
    const specifier = new URL(
      "../../../scripts/lib/openssh-key.mjs",
      import.meta.url,
    ).href;
    const mod: unknown = await import(specifier);
    const generateOpensshEd25519HostKey = (
      mod as { generateOpensshEd25519HostKey: () => string }
    ).generateOpensshEd25519HostKey;
    const pem = generateOpensshEd25519HostKey();
    const parsed = utils.parseKey(pem);
    expect(parsed).not.toBeInstanceOf(Error);
    expect((parsed as { type: string }).type).toBe("ssh-ed25519");
  });

  // install.sh must mint the SAME key material inside a bare node container
  // (no repo checkout for curl|sh), so it INLINES the encoder as
  // GEN_SSH_MATERIAL_JS. That copy has no other automated coverage — extract
  // it, run it in plain node, and hold its output to the same ssh2 + crypto
  // bar, so a drift between the two implementations fails here.
  it("install.sh's inlined generator produces the same valid material", () => {
    const install = new URL("../../../scripts/install.sh", import.meta.url)
      .pathname;
    const sh = readFileSync(install, "utf8");
    const match = /GEN_SSH_MATERIAL_JS='([\s\S]*?)\n'\n/.exec(sh);
    expect(match, "GEN_SSH_MATERIAL_JS not found in install.sh").not.toBeNull();
    // Un-escape the POSIX single-quote sequences ('"'"' → ') back to runnable JS.
    const js = (match?.[1] ?? "").replaceAll(`'"'"'`, `'`);
    const out = execFileSync(process.execPath, ["-e", js], {
      encoding: "utf8",
    });
    const env = new Map<string, string>();
    for (const line of out.split("\n").filter(Boolean)) {
      const eq = line.indexOf("=");
      let value = line.slice(eq + 1);
      if (value.startsWith('"')) value = JSON.parse(value) as string;
      env.set(line.slice(0, eq), value);
    }
    const caPem = env.get("SSH_CA_PRIVATE_KEY") ?? "";
    const caLine = env.get("TERMINATOR_CA_PUBLIC_KEY") ?? "";
    const hostKey = env.get("TERMINATOR_HOST_KEY") ?? "";
    const crypto = require("node:crypto") as typeof import("node:crypto");
    expect(crypto.createPrivateKey(caPem).asymmetricKeyType).toBe("ed25519");
    expect(caLine).toMatch(/^ssh-ed25519 /);
    const host = utils.parseKey(hostKey);
    expect(host).not.toBeInstanceOf(Error);
    expect((host as { type: string }).type).toBe("ssh-ed25519");
  });
});
