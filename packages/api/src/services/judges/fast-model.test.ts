import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { askDecisions, askFastModel } from "./fast-model";

/**
 * What the fast calls send: the fast model per provider with thinking off,
 * a refusal as a throw, and the Decisions API's typed answers. The key's
 * resolution and each key kind's auth shape are llm-direct-call.test.ts's;
 * the provider endpoints are a real local server behind the
 * `*_API_BASE_URL` overrides.
 */

interface ModelRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let server: Server | undefined;
let requests: ModelRequest[];

const startFake = async (
  respond: (req: ModelRequest) => { status?: number; body?: unknown },
): Promise<string> => {
  requests = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const request: ModelRequest = {
        path: req.url ?? "/",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(request);
      const answer = respond(request);
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(answer.body ?? {}));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

const ask = { prompt: "one word", maxTokens: 8 };

afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.ANTHROPIC_API_BASE_URL;
  delete process.env.OPENAI_API_BASE_URL;
});

describe("askFastModel", () => {
  it("Anthropic API key: Haiku 5.5, thinking off at low effort, x-api-key, no identity block", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: { content: [{ type: "text", text: "rocket" }] },
    }));
    const answer = await askFastModel(
      { provider: "anthropic", authMode: "api-key", value: "sk-ant-key" },
      { ...ask, signal: AbortSignal.timeout(5_000) },
    );
    expect(answer).toBe("rocket");
    const [sent] = requests;
    expect(sent?.path).toBe("/v1/messages");
    expect(sent?.headers["x-api-key"]).toBe("sk-ant-key");
    expect(sent?.headers.authorization).toBeUndefined();
    expect(sent?.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 8,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
    });
    expect(sent?.body.system).toBeUndefined();
  });

  it("Claude subscription: a Bearer with the Claude Code identity as the first system block", async () => {
    // Live, 2026-10-14: without the identity block Anthropic answers a
    // subscription token with a bare 429 on every model.
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: { content: [{ type: "text", text: "rocket" }] },
    }));
    await askFastModel(
      { provider: "anthropic", authMode: "oauth", value: "sk-ant-oat" },
      { ...ask, signal: AbortSignal.timeout(5_000) },
    );
    const [sent] = requests;
    expect(sent?.headers.authorization).toBe("Bearer sk-ant-oat");
    expect(sent?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(sent?.headers["x-api-key"]).toBeUndefined();
    expect(sent?.body.system).toEqual([
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ]);
  });

  it("a safety-classifier decline (HTTP 200, stop_reason refusal) throws, never reads as an empty answer", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      body: { content: [], stop_reason: "refusal" },
    }));
    await expect(
      askFastModel(
        { provider: "anthropic", authMode: "api-key", value: "k" },
        { ...ask, signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toThrow("refusal");
  });

  it("an HTTP refusal throws, with ONE call (no second model to burn the budget on)", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startFake(() => ({
      status: 429,
      body: { type: "error" },
    }));
    await expect(
      askFastModel(
        { provider: "anthropic", authMode: "api-key", value: "k" },
        { ...ask, signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toThrow("(429)");
    expect(requests).toHaveLength(1);
  });

  it("OpenAI: gpt-6-luna with reasoning off, capped by max_completion_tokens", async () => {
    // gpt-4o-mini is shut down 2027-01-14 (gpt-6-luna is OpenAI's named
    // replacement); `max_tokens` is deprecated for reasoning models.
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({
      body: { choices: [{ message: { content: "eyes" } }] },
    }));
    const answer = await askFastModel(
      { provider: "openai", value: "sk-key" },
      { ...ask, signal: AbortSignal.timeout(5_000) },
    );
    expect(answer).toBe("eyes");
    const [sent] = requests;
    expect(sent?.path).toBe("/v1/chat/completions");
    expect(sent?.headers.authorization).toBe("Bearer sk-key");
    expect(sent?.body).toMatchObject({
      model: "gpt-6-luna",
      max_completion_tokens: 8,
      reasoning_effort: "none",
    });
    expect(sent?.body.max_tokens).toBeUndefined();
  });

  it("an aborted signal cancels the call", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      askFastModel(
        { provider: "openai", value: "sk-key" },
        { ...ask, signal: aborted.signal },
      ),
    ).rejects.toThrow();
  });
});

describe("askDecisions", () => {
  it("posts typed choice questions and maps choice answers; a refused question is absent", async () => {
    process.env.OPENAI_API_BASE_URL = await startFake(() => ({
      body: {
        answers: [
          { type: "choice", name: "who", choice: "agent", confidence: 0.9 },
          { type: "refusal", name: "where" },
        ],
      },
    }));
    const answers = await askDecisions(
      { provider: "openai", value: "sk-key" },
      {
        input: "context",
        signal: AbortSignal.timeout(5_000),
        questions: [
          {
            name: "who",
            instructions: "Who?",
            choices: [{ value: "agent", description: "The agent." }],
          },
          {
            name: "where",
            instructions: "Where?",
            choices: [{ value: "channel", description: "The channel." }],
          },
        ],
      },
    );
    expect(answers.get("who")).toEqual({ choice: "agent", confidence: 0.9 });
    expect(answers.has("where")).toBe(false);
    const [sent] = requests;
    expect(sent?.path).toBe("/v1/decisions");
    expect(sent?.body).toMatchObject({
      model: "gpt-6-luna",
      input: "context",
      questions: [
        { type: "choice", name: "who" },
        { type: "choice", name: "where" },
      ],
    });
  });
});
