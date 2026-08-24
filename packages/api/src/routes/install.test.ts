import { beforeEach, describe, expect, it, vi } from "vitest";

// The install-script endpoint's param contract and script shape: the
// `tool=` / `agent=` split, the legacy `agent=<framework>` mapping, and the
// loud (never silent) agent-pin block. The script itself is asserted as text —
// it IS the product here.

const onboardingService = vi.hoisted(() => ({
  markOnboardingCompleteByApiKey: vi.fn(async () => {}),
}));

vi.mock("../services/onboarding-service", () => ({
  markOnboardingCompleteByApiKey:
    onboardingService.markOnboardingCompleteByApiKey,
}));

vi.mock("../providers", () => ({
  getSelfUrl: () => "https://api.test.example",
}));

const { installRoutes } = await import("./install");

const app = installRoutes();
const KEY = `oc_${"a".repeat(64)}`;

const fetchScript = async (query: string) => {
  const res = await app.request(`/cli?${query}`);
  expect(res.status).toBe(200);
  return res.text();
};

beforeEach(() => {
  onboardingService.markOnboardingCompleteByApiKey.mockClear();
});

describe("GET /cli — param contract", () => {
  // The snippet's api-host variable is ONECLI_API_HOST — the old ONECLI_URL
  // name collided with the dashboard-URL meaning elsewhere and is banned for
  // new surfaces (routes/migrate-nanoclaw.ts keeps it, frozen field format).
  it("names the api host ONECLI_API_HOST, never ONECLI_URL", async () => {
    const script = await fetchScript(`key=${KEY}`);
    expect(script).toContain('ONECLI_API_HOST="https://api.test.example"');
    expect(script).toContain('onecli config set api-host "$ONECLI_API_HOST"');
    expect(script).not.toMatch(/\bONECLI_URL\b/);
  });

  it("rejects a malformed key", async () => {
    const res = await app.request("/cli?key=oc_short");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown tool", async () => {
    const res = await app.request(`/cli?key=${KEY}&tool=vim`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid tool identifier" });
  });

  it("rejects a malformed agent identifier", async () => {
    const res = await app.request(`/cli?key=${KEY}&tool=codex&agent=Bad_Name`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid agent identifier" });
  });

  it("marks onboarding complete when a key is present", async () => {
    await fetchScript(`key=${KEY}`);
    expect(
      onboardingService.markOnboardingCompleteByApiKey,
    ).toHaveBeenCalledWith(KEY);
  });

  it("keyless request emits the device-auth flow and skips the marker", async () => {
    const script = await fetchScript("tool=claude-code");
    expect(script).toContain("/v1/auth/cli/session");
    expect(
      onboardingService.markOnboardingCompleteByApiKey,
    ).not.toHaveBeenCalled();
  });
});

describe("GET /cli — legacy agent=<framework> mapping", () => {
  it("treats a bare legacy framework id as the tool", async () => {
    const script = await fetchScript(`key=${KEY}&agent=claude-code`);
    // Alias tip proves it was consumed as a tool…
    expect(script).toContain('alias claude=\\"onecli run -- claude\\"');
    // …and no agent pin is written.
    expect(script).not.toContain("config set agent");
  });

  it("never resurrects the rejected default-agent config key", async () => {
    const legacy = await fetchScript(`key=${KEY}&agent=claude-code`);
    const modern = await fetchScript(`key=${KEY}&tool=codex&agent=writer-bot`);
    expect(legacy).not.toContain("default-agent");
    expect(modern).not.toContain("default-agent");
  });

  it("with tool= present, agent= is an identifier even when it spells a tool", async () => {
    const script = await fetchScript(
      `key=${KEY}&tool=cursor&agent=claude-code`,
    );
    expect(script).toContain('AGENT="claude-code"');
    expect(script).toContain('onecli config set agent "$AGENT"');
  });
});

describe("GET /cli — script shape", () => {
  it("pins the chosen agent loudly, with the old-CLI fallback", async () => {
    const script = await fetchScript(`key=${KEY}&tool=codex&agent=writer-bot`);
    expect(script).toContain('AGENT="writer-bot"');
    expect(script).toContain('if onecli config set agent "$AGENT"');
    expect(script).toContain("onecli run --agent $AGENT -- <command>");
    expect(script).toContain("alias codex");
  });

  it("an identifier-only request pins but suggests no alias", async () => {
    const script = await fetchScript(`key=${KEY}&agent=writer-bot`);
    expect(script).toContain('onecli config set agent "$AGENT"');
    expect(script).not.toContain("Add a shortcut");
  });

  it("no agent param → no pin block at all", async () => {
    const script = await fetchScript(`key=${KEY}&tool=claude-code`);
    expect(script).not.toContain("config set agent");
  });

  it("supports every CLI-table tool", async () => {
    for (const [tool, alias] of [
      ["claude-code", "claude"],
      ["cursor", "cursor"],
      ["codex", "codex"],
      ["hermes", "hermes"],
      ["opencode", "opencode"],
      ["openclaw", "openclaw"],
    ]) {
      const script = await fetchScript(`key=${KEY}&tool=${tool}`);
      expect(script, tool).toContain(`alias ${alias}`);
    }
  });

  it("aliases a multi-word run command to its one-word shortcut", async () => {
    const script = await fetchScript(`key=${KEY}&tool=openclaw`);
    expect(script).toContain(
      'alias openclaw=\\"onecli run -- openclaw gateway run\\"',
    );
    expect(script).toContain("After that, just run: openclaw");
  });

  it("keeps accepting legacy github-copilot without offering it anywhere new", async () => {
    // Old dialog URLs and the onboarding survey still send it — a copied
    // command must never start failing.
    const asTool = await fetchScript(`key=${KEY}&tool=github-copilot`);
    expect(asTool).toContain("alias copilot");
    const asLegacyAgent = await fetchScript(`key=${KEY}&agent=github-copilot`);
    expect(asLegacyAgent).toContain("alias copilot");
    expect(asLegacyAgent).not.toContain("config set agent");
  });

  it("keeps the install-complete notification", async () => {
    const script = await fetchScript(`key=${KEY}&tool=claude-code`);
    expect(script).toContain("/v1/onboarding/install-complete");
  });

  it("every variant is syntactically valid shell (sh -n)", async () => {
    const { spawnSync } = await import("node:child_process");
    const variants = [
      `key=${KEY}&tool=claude-code&agent=writer-bot`,
      `key=${KEY}&agent=claude-code`,
      `key=${KEY}`,
      "tool=opencode",
      // The multi-word alias template nests quotes — the likeliest place for
      // the generated shell to go syntactically wrong.
      `key=${KEY}&tool=openclaw&agent=openclaw-bot`,
    ];
    for (const query of variants) {
      const script = await fetchScript(query);
      const check = spawnSync("sh", ["-n"], { input: script });
      expect(check.status, `sh -n failed for ?${query}: ${check.stderr}`).toBe(
        0,
      );
    }
  });
});
