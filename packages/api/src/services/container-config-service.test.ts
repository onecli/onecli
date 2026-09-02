import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { initPlatformLlm } from "../providers/platform-llm";

/**
 * The bootstrap builder's zero-credential invariant (§3.2, invariant 1): what
 * this function returns is literally what lands inside a sandbox, so the
 * assertions here are the last line of defense before a real credential could
 * cross that line.
 */

const CA_PEM =
  "-----BEGIN CERTIFICATE-----\nPUBLIC-CERT-BODY\n-----END CERTIFICATE-----";

const mocks = vi.hoisted(() => ({
  loadCaCertificate: vi.fn(),
  secretFindFirst: vi.fn(),
  secretFindMany: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    secret: {
      findFirst: mocks.secretFindFirst,
      findMany: mocks.secretFindMany,
    },
  },
}));

vi.mock("../lib/gateway-ca", () => ({
  loadCaCertificate: mocks.loadCaCertificate,
}));

vi.mock("../providers", () => ({
  getCrypto: () => ({ decrypt: mocks.decrypt }),
}));

vi.mock("./policy-reflect/injection", () => ({
  grantedSecretSelection: () => ({ ids: ["sec-1"], levels: new Set() }),
}));
vi.mock("./policy-simulate/load-rules", () => ({
  loadInjectionRules: async () => [],
}));
vi.mock("./policy-simulate/principal-set", () => ({
  resolvePrincipalSet: async () => ({}),
}));

const { buildContainerConfig } = await import("./container-config-service");

const AGENT = { id: "ag-1", accessToken: "aoc_agent_token" };

const build = () =>
  buildContainerConfig({
    agent: AGENT,
    workspaceId: "p-1",
    organizationId: "o-1",
  });

beforeEach(() => {
  mocks.loadCaCertificate.mockReturnValue(CA_PEM);
  mocks.secretFindFirst.mockResolvedValue(null);
  // The credential resolver reads the same fenced pool with findMany; empty
  // by default, which is the "no key granted" shape these tests assume.
  mocks.secretFindMany.mockResolvedValue([]);
  mocks.decrypt.mockResolvedValue("REAL-SECRET-VALUE");
});

describe("the zero-credential line", () => {
  it("puts ONLY a placeholder in the model-key variable", async () => {
    mocks.secretFindFirst.mockResolvedValue({
      metadata: { authMode: "api_key" },
      encryptedValue: "enc",
    });

    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.config.env.ANTHROPIC_API_KEY).toBe("placeholder");
  });

  it("never lets a decrypted secret value reach the payload", async () => {
    mocks.secretFindFirst.mockResolvedValue({
      metadata: { authMode: "api_key" },
      encryptedValue: "enc",
    });

    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(JSON.stringify(result.config)).not.toContain("REAL-SECRET-VALUE");
  });

  it("ships the CA CERTIFICATE and never a private key", async () => {
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.config.caCertificate).toBe(CA_PEM);
    const serialized = JSON.stringify(result.config);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("BEGIN RSA");
  });

  it("carries the agent's proxy token in the proxy URL, and nothing else", async () => {
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.config.env.HTTPS_PROXY).toContain("aoc_agent_token");
    // The proxy principal authorizes proxied traffic only — it must never be
    // handed over as a general credential variable.
    const proxyVars = [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "https_proxy",
      "http_proxy",
    ];
    const rest = Object.fromEntries(
      Object.entries(result.config.env).filter(
        ([key]) => !proxyVars.includes(key),
      ),
    );
    expect(JSON.stringify(rest)).not.toContain("aoc_agent_token");
  });

  it("targets ONECLI_AGENT_PROXY_ADDRESS, with GATEWAY_BASE_URL as the alias", async () => {
    // The proxy host comes from the resolver's agent-proxy chain: new name,
    // then the legacy alias, then host.docker.internal. Hermetic setup
    // deletes both vars before this file, so the default backs the other
    // cases in this suite.
    vi.stubEnv("ONECLI_AGENT_PROXY_ADDRESS", "203.0.113.9:24814");
    try {
      const result = await build();
      if (!result.ok) throw new Error("expected a config");
      expect(result.config.env.HTTPS_PROXY).toContain("@203.0.113.9:24814");
    } finally {
      vi.unstubAllEnvs();
    }

    vi.stubEnv("GATEWAY_BASE_URL", "198.51.100.7:24814");
    try {
      const result = await build();
      if (!result.ok) throw new Error("expected a config");
      expect(result.config.env.HTTPS_PROXY).toContain("@198.51.100.7:24814");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("points every TLS client at the CA path", async () => {
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    const path = result.config.caCertificateContainerPath;
    expect(result.config.env).toMatchObject({
      NODE_EXTRA_CA_CERTS: path,
      SSL_CERT_FILE: path,
      CURL_CA_BUNDLE: path,
      GIT_SSL_CAINFO: path,
    });
  });

  it("refuses to build when the CA is unavailable, rather than shipping none", async () => {
    mocks.loadCaCertificate.mockReturnValue(null);

    const result = await build();

    expect(result).toEqual({ ok: false, reason: "ca_unavailable" });
  });
});

describe("auth-mode detection (invariant 2)", () => {
  it("uses the OAuth variable for an OAuth-mode secret", async () => {
    mocks.secretFindFirst.mockImplementation(
      async ({ where }: { where: { AND: Array<{ type?: string }> } }) => {
        const type = where.AND.find((clause) => clause.type)?.type;
        return type === "anthropic"
          ? { metadata: { authMode: "oauth" }, encryptedValue: null }
          : null;
      },
    );

    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("placeholder");
    expect(result.config.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("warns — rather than silently succeeding — when no credential is granted", async () => {
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.config.warnings?.[0]).toContain("No Anthropic credentials");
  });
});

describe("which provider's variables the container gets", () => {
  /** What the credential resolver sees; the secret rows it ranks. */
  const granted = (
    rows: Array<{ type: string; scope?: string; metadata?: unknown }>,
  ) =>
    mocks.secretFindMany.mockResolvedValue(
      rows.map((row, index) => ({
        id: `sec-${index}`,
        type: row.type,
        scope: row.scope ?? "workspace",
        metadata: row.metadata ?? null,
        valueSource: "inline",
        encryptedValue: "enc",
      })),
    );

  it("sets NO model-key variable when nothing is granted", async () => {
    // Regression. This used to emit ANTHROPIC_API_KEY="placeholder"
    // unconditionally, which broke both editions at once: a hosted sandbox
    // picked Anthropic because the variable was set and 401'd forever, and a
    // BYO container had its user's own real key shadowed by the word
    // "placeholder" — while the warning below promised the opposite.
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.config.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result.config.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(result.config.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(result.llmCredential).toBeNull();
  });

  it("reports the granted provider so the caller can decide what to do", async () => {
    granted([{ type: "openai" }]);
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.llmCredential).toMatchObject({
      provider: "openai",
      authMode: "api-key",
    });
  });

  it("prefers a WORKSPACE key over an ORG one, whatever the provider", async () => {
    // The user's decision: the more specific grant is the more deliberate one.
    granted([
      { type: "anthropic", scope: "organization" },
      { type: "openai", scope: "workspace" },
    ]);
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.llmCredential?.provider).toBe("openai");
  });

  it("falls back to provider order only when the scopes tie", async () => {
    granted([
      { type: "openai", scope: "workspace" },
      { type: "anthropic", scope: "workspace" },
    ]);
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.llmCredential?.provider).toBe("anthropic");
  });
});

describe("the platform trial credential", () => {
  // The provider seam defaults to null under test (uninjected = dark), so
  // these cases install a stub explicitly and reset it after.
  afterEach(() => {
    initPlatformLlm(null);
  });

  it("advertises Anthropic for a keyless agent when the credit applies", async () => {
    initPlatformLlm({ trialCreditApplies: () => true });

    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    // The placeholder is the whole hand-off: the harness picks Claude, the
    // gateway splices the platform key at the wire. No real value here.
    expect(result.config.env.ANTHROPIC_API_KEY).toBe("placeholder");
    expect(result.llmCredential).toMatchObject({
      provider: "anthropic",
      scope: "platform",
      secretId: "platform:anthropic",
      // The control plane holds no readable value — the key lives only in
      // the gateway's env.
      hasReadableValue: false,
    });
    // No "connect a key" warning: the agent can run.
    expect(result.config.warnings).toBeUndefined();
  });

  it("stands down when the pool has an LLM key — the user's key wins", async () => {
    // The eligibility stub sees the UNFILTERED pool; a real implementation
    // answers false for a pool with any LLM key. What this case pins is the
    // precedence: when a user key resolves, the platform credential is not
    // even consulted for the result shape.
    initPlatformLlm({ trialCreditApplies: () => false });
    mocks.secretFindMany.mockResolvedValue([
      {
        id: "sec-own",
        type: "openai",
        scope: "workspace",
        metadata: null,
        valueSource: "inline",
        encryptedValue: "enc",
      },
    ]);

    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.llmCredential?.provider).toBe("openai");
    expect(result.llmCredential?.scope).not.toBe("platform");
  });

  it("stays dark when the provider is not injected (onprem, or cloud unconfigured)", async () => {
    const result = await build();
    if (!result.ok) throw new Error("expected a config");

    expect(result.config.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result.llmCredential).toBeNull();
    expect(result.config.warnings?.[0]).toContain("No Anthropic credentials");
  });
});
