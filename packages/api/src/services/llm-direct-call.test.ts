import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The shared server-side call, per key kind: which credentials resolve to a
 * usable key at all, and exactly what each provider is sent. Credential
 * resolution is mocked at the module seam (its fenced behavior is proven in
 * the llm-credential pg suites); the provider endpoints are a real local
 * server behind the `*_API_BASE_URL` overrides. The subscription rows are
 * the regression: without the Claude Code identity as the first system
 * block, Anthropic answers a subscription token with a bare 429.
 */

const resolution = vi.hoisted(() => ({
  where: vi.fn<() => Promise<object>>(),
  credential: vi.fn<() => Promise<unknown>>(async () => null),
  value: vi.fn<() => Promise<string | null>>(async () => null),
}));

vi.mock("./injectable-secrets", () => ({
  injectableSecretWhere: resolution.where,
}));
vi.mock("./llm-credential-service", () => ({
  resolveAgentLlmCredential: resolution.credential,
  readLlmCredentialValue: resolution.value,
}));

const {
  callLlm,
  LlmCallError,
  LlmModelUnavailableError,
  postToProvider,
  resolveLlmCallKey,
} = await import("./llm-direct-call");

/** Pinned as a literal: Anthropic matches this exact text. */
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const AGENT = { id: "ag1", workspaceId: "w1" };
/** Stands in for the agent's fenced grant filter. */
const FENCE = { fenced: "ag1" };

const credential = (
  provider: "anthropic" | "openai",
  authMode: "api-key" | "oauth" = "api-key",
  hasReadableValue = true,
) => ({
  provider,
  secretId: "sec1",
  authMode,
  scope: "workspace",
  hasReadableValue,
});

interface SeenRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let server: Server | undefined;
let seen: SeenRequest[];

const startFake = async (
  respond: (req: SeenRequest) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<string> => {
  seen = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const request: SeenRequest = {
        path: req.url ?? "/",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      seen.push(request);
      const answer = respond(request);
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...answer.headers,
      });
      res.end(JSON.stringify(answer.body ?? {}));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

beforeEach(() => {
  resolution.where.mockReset();
  resolution.where.mockResolvedValue(FENCE);
  resolution.credential.mockReset();
  resolution.credential.mockResolvedValue(null);
  resolution.value.mockReset();
  resolution.value.mockResolvedValue(null);
});

afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.ANTHROPIC_API_BASE_URL;
  delete process.env.OPENAI_API_BASE_URL;
});

const API_KEY = {
  provider: "anthropic",
  authMode: "api-key",
  value: "sk-ant-api",
} as const;
const SUBSCRIPTION = {
  provider: "anthropic",
  authMode: "oauth",
  value: "sk-ant-oat-x",
} as const;
const OPENAI = { provider: "openai", value: "sk-oa" } as const;

const CALL = {
  model: "m1",
  system: "Grade strictly.",
  prompt: "Is 2+2=4?",
  maxTokens: 100,
};
const signal = () => AbortSignal.timeout(5_000);
const SCHEMA = { name: "verdict", schema: { type: "object" } };

const anthropicText = (text: string, stopReason = "end_turn") => ({
  stop_reason: stopReason,
  content: [{ type: "text", text }],
});

describe("resolveLlmCallKey", () => {
  it("looks up and reads the key through the agent's own fence, nothing wider", async () => {
    resolution.credential.mockResolvedValue(credential("anthropic"));
    resolution.value.mockResolvedValue("sk-ant-api");
    await resolveLlmCallKey(AGENT, "org1");
    expect(resolution.where).toHaveBeenCalledWith({ id: "ag1" }, "w1", "org1");
    expect(resolution.credential).toHaveBeenCalledWith(AGENT, "org1", FENCE);
    expect(resolution.value).toHaveBeenCalledWith(AGENT, "org1", "sec1", FENCE);
  });

  it("no grant: missing, and nothing is read", async () => {
    expect(await resolveLlmCallKey(AGENT, "org1")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(resolution.value).not.toHaveBeenCalled();
  });

  it("a value outside OneCLI's store (1Password, the platform trial credit): not-stored, never read", async () => {
    resolution.credential.mockResolvedValue(
      credential("anthropic", "api-key", false),
    );
    expect(await resolveLlmCallKey(AGENT, "org1")).toEqual({
      ok: false,
      reason: "not-stored",
    });
    expect(resolution.value).not.toHaveBeenCalled();
  });

  it("a ChatGPT sign-in is refused before its value is ever decrypted", async () => {
    resolution.credential.mockResolvedValue(credential("openai", "oauth"));
    expect(await resolveLlmCallKey(AGENT, "org1")).toEqual({
      ok: false,
      reason: "chatgpt-login",
    });
    expect(resolution.value).not.toHaveBeenCalled();
  });

  it("a stored value that cannot be read back: unreadable", async () => {
    resolution.credential.mockResolvedValue(credential("anthropic"));
    expect(await resolveLlmCallKey(AGENT, "org1")).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("an Anthropic key keeps its auth mode; an OpenAI API key is used as stored", async () => {
    resolution.credential.mockResolvedValue(credential("anthropic", "oauth"));
    resolution.value.mockResolvedValue("sk-ant-oat");
    expect(await resolveLlmCallKey(AGENT, "org1")).toEqual({
      ok: true,
      key: { provider: "anthropic", authMode: "oauth", value: "sk-ant-oat" },
    });
    resolution.credential.mockResolvedValue(credential("openai"));
    resolution.value.mockResolvedValue("sk-plain");
    expect(await resolveLlmCallKey(AGENT, "org1")).toEqual({
      ok: true,
      key: { provider: "openai", value: "sk-plain" },
    });
  });
});

describe("callLlm: Anthropic API key", () => {
  it("sends x-api-key and the caller's system prompt only", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: anthropicText("yes"),
    }));
    expect(await callLlm(API_KEY, { ...CALL, signal: signal() })).toEqual({
      text: "yes",
    });
    const [sent] = seen;
    expect(sent?.path).toBe("/v1/messages");
    expect(sent?.headers["x-api-key"]).toBe("sk-ant-api");
    expect(sent?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent?.headers.authorization).toBeUndefined();
    expect(sent?.body.system).toEqual([
      { type: "text", text: "Grade strictly." },
    ]);
  });

  it("thinking off: thinking disabled at low effort, alongside a JSON schema", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: anthropicText("yes"),
    }));
    await callLlm(API_KEY, {
      ...CALL,
      jsonSchema: SCHEMA,
      thinking: "off",
      signal: signal(),
    });
    expect(seen[0]?.body).toMatchObject({
      model: "m1",
      max_tokens: 100,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: { type: "object" } },
      },
    });
  });

  it("thinks by default: no thinking or effort sent", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: anthropicText("yes"),
    }));
    await callLlm(API_KEY, { ...CALL, signal: signal() });
    expect(seen[0]?.body.thinking).toBeUndefined();
    expect(seen[0]?.body.output_config).toBeUndefined();
  });

  it("surfaces refusal and max_tokens stops to the caller", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: anthropicText("{}", "refusal"),
    }));
    expect(await callLlm(API_KEY, { ...CALL, signal: signal() })).toEqual({
      text: "{}",
      stopReason: "refusal",
    });
  });

  it("a refused key is final and never echoes the key", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      status: 401,
    }));
    const err = await callLlm(API_KEY, { ...CALL, signal: signal() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmCallError);
    expect(err).toMatchObject({
      message: "The Anthropic key was refused by the provider (401)",
      final: true,
    });
    expect(String(err)).not.toContain("sk-ant-api");
  });
});

describe("callLlm: Claude subscription", () => {
  it("sends a Bearer with the oauth beta and the Claude Code identity FIRST", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: anthropicText("yes"),
    }));
    await callLlm(SUBSCRIPTION, { ...CALL, signal: signal() });
    const [sent] = seen;
    expect(sent?.headers.authorization).toBe("Bearer sk-ant-oat-x");
    expect(sent?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(sent?.headers["x-api-key"]).toBeUndefined();
    expect(sent?.body.system).toEqual([
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      { type: "text", text: "Grade strictly." },
    ]);
  });

  it("still sends the identity when the caller has no system prompt", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: anthropicText("eyes"),
    }));
    await callLlm(SUBSCRIPTION, {
      ...CALL,
      system: undefined,
      signal: signal(),
    });
    expect(seen[0]?.body.system).toEqual([
      { type: "text", text: CLAUDE_CODE_IDENTITY },
    ]);
  });

  it("reports a 429 as the subscription's usage limit, retryable", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      status: 429,
    }));
    const err = await callLlm(SUBSCRIPTION, {
      ...CALL,
      signal: signal(),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message:
        "The Claude subscription usage limit was reached (429); try again later",
      final: false,
    });
  });

  it("reports a refused token as a login, final, without the token", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      status: 403,
    }));
    const err = await callLlm(SUBSCRIPTION, {
      ...CALL,
      signal: signal(),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message:
        "The Claude subscription login was refused by the provider (403)",
      final: true,
    });
    expect(String(err)).not.toContain("sk-ant-oat-x");
  });
});

describe("callLlm: OpenAI API key", () => {
  it("sends a Bearer to Chat Completions with strict structured output", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({
      body: { choices: [{ message: { content: "yes" } }] },
    }));
    expect(
      await callLlm(OPENAI, { ...CALL, jsonSchema: SCHEMA, signal: signal() }),
    ).toEqual({ text: "yes" });
    const [sent] = seen;
    expect(sent?.path).toBe("/v1/chat/completions");
    expect(sent?.headers.authorization).toBe("Bearer sk-oa");
    expect(sent?.body).toMatchObject({
      model: "m1",
      max_completion_tokens: 100,
      response_format: {
        type: "json_schema",
        json_schema: { name: "verdict", strict: true, schema: SCHEMA.schema },
      },
      messages: [
        { role: "system", content: "Grade strictly." },
        { role: "user", content: "Is 2+2=4?" },
      ],
    });
    expect(sent?.body.max_tokens).toBeUndefined();
    expect(sent?.body.reasoning_effort).toBeUndefined();
  });

  it("thinking off: reasoning_effort none", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({
      body: { choices: [{ message: { content: "yes" } }] },
    }));
    await callLlm(OPENAI, { ...CALL, thinking: "off", signal: signal() });
    expect(seen[0]?.body.reasoning_effort).toBe("none");
  });

  it("a structured-output refusal and a length cut-off reach the caller", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({
      body: { choices: [{ message: { content: null, refusal: "no" } }] },
    }));
    expect(await callLlm(OPENAI, { ...CALL, signal: signal() })).toEqual({
      text: "",
      stopReason: "refusal",
    });
    server?.close();
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({
      body: {
        choices: [{ finish_reason: "length", message: { content: "{" } }],
      },
    }));
    expect(await callLlm(OPENAI, { ...CALL, signal: signal() })).toEqual({
      text: "{",
      stopReason: "max_tokens",
    });
  });

  it("keeps the 'rate limiting the key' wording for an API key 429", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({ status: 429 }));
    await expect(
      callLlm(OPENAI, { ...CALL, signal: signal() }),
    ).rejects.toThrow("The OpenAI provider is rate limiting the key (429)");
  });

  it("reports a model the endpoint cannot run (404) as unavailable, final", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({ status: 404 }));
    const err = await callLlm(OPENAI, { ...CALL, signal: signal() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmModelUnavailableError);
    expect(err).toMatchObject({
      message: "The OpenAI provider cannot run the requested model (404)",
      final: true,
    });
    expect(String(err)).not.toContain("sk-oa");
  });
});

describe("postToProvider", () => {
  it("a reply that does not match the expected shape is a provider error, not a crash", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({
      body: { unexpected: true },
    }));
    const err = await postToProvider(
      OPENAI,
      "/v1/decisions",
      {},
      z.object({ answers: z.array(z.unknown()) }),
      signal(),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: "The OpenAI provider returned a reply that could not be read",
      final: false,
    });
  });

  it("never follows a redirect, so the key is sent to one URL only", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake((req) =>
      req.path === "/v1/x"
        ? { status: 307, headers: { location: "/elsewhere" } }
        : { body: {} },
    );
    await expect(
      postToProvider(OPENAI, "/v1/x", {}, z.unknown(), signal()),
    ).rejects.toThrow();
    expect(seen.map((req) => req.path)).toEqual(["/v1/x"]);
  });
});
