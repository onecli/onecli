import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chooser's whole contract is graceful degradation: an AI pick when the
 * fenced key resolution and a FAST model call both cooperate, `eyes` on any
 * other path — and never a thrown error (the callers are detached tasks
 * behind an ingest ack). Credential resolution is mocked at the module seam
 * (its own fenced behavior is proven in the llm-credential pg suites); the
 * model endpoint is a real local server behind ANTHROPIC_API_BASE_URL.
 */

const resolution = vi.hoisted(() => ({
  where: vi.fn(async () => ({}) as object),
  credential: vi.fn<() => Promise<unknown>>(async () => null),
  value: vi.fn<() => Promise<string | null>>(async () => null),
}));

vi.mock("../injectable-secrets", () => ({
  injectableSecretWhere: resolution.where,
}));
vi.mock("../llm-credential-service", () => ({
  resolveAgentLlmCredential: resolution.credential,
  readLlmCredentialValue: resolution.value,
}));

const { chooseReaction, FALLBACK_REACTION } =
  await import("./reaction-chooser");

const AGENT = {
  agent: { id: "ag1", workspaceId: "p1" },
  organizationId: "org1",
  text: "please deploy the release",
};

const anthropicCredential = {
  provider: "anthropic",
  secretId: "sec1",
  authMode: "api-key",
  scope: "workspace",
  hasReadableValue: true,
};

interface ModelRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let server: Server | undefined;
let requests: ModelRequest[];

const startModelFake = async (
  respond: (req: ModelRequest) => { status?: number; body?: unknown } | "hang",
): Promise<string> => {
  requests = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const request: ModelRequest = {
        path: req.url ?? "/",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(request);
      const answer = respond(request);
      if (answer === "hang") return; // never responds — the timeout arm
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

beforeEach(() => {
  resolution.where.mockClear();
  resolution.credential.mockReset();
  resolution.credential.mockResolvedValue(null);
  resolution.value.mockReset();
  resolution.value.mockResolvedValue(null);
});

afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.ANTHROPIC_API_BASE_URL;
});

describe("chooseReaction", () => {
  it("returns the model's pick when it is allowlisted (normalizing ':name:' forms)", async () => {
    resolution.credential.mockResolvedValue(anthropicCredential);
    resolution.value.mockResolvedValue("sk-ant-api-key");
    process.env.ANTHROPIC_API_BASE_URL = await startModelFake(() => ({
      body: { content: [{ type: "text", text: " :Thumbsup: " }] },
    }));

    expect(await chooseReaction(AGENT)).toBe("thumbsup");
    // The credential travelled as x-api-key (api-key mode), never logged.
    expect(requests[0]?.headers["x-api-key"]).toBe("sk-ant-api-key");
    expect(requests[0]?.path).toBe("/v1/messages");
  });

  it("falls back on a non-allowlisted answer — the allowlist IS the output boundary", async () => {
    // MUTATION-PROOF: skip the isAllowlisted check and a prompt-injected
    // message could name ANY Slack reaction through the model's mouth.
    resolution.credential.mockResolvedValue(anthropicCredential);
    resolution.value.mockResolvedValue("sk-ant-api-key");
    process.env.ANTHROPIC_API_BASE_URL = await startModelFake(() => ({
      body: { content: [{ type: "text", text: "middle_finger" }] },
    }));

    expect(await chooseReaction(AGENT)).toBe(FALLBACK_REACTION);
  });

  it("falls back with ZERO model calls when no key is granted", async () => {
    process.env.ANTHROPIC_API_BASE_URL = await startModelFake(() => ({
      body: {},
    }));
    expect(await chooseReaction(AGENT)).toBe(FALLBACK_REACTION);
    expect(requests).toHaveLength(0);
  });

  it("falls back when the model call times out (the 1.5s ceiling)", async () => {
    resolution.credential.mockResolvedValue(anthropicCredential);
    resolution.value.mockResolvedValue("sk-ant-api-key");
    process.env.ANTHROPIC_API_BASE_URL = await startModelFake(() => "hang");

    expect(await chooseReaction(AGENT)).toBe(FALLBACK_REACTION);
  }, 10_000);

  it("falls back on an HTTP refusal and never throws", async () => {
    resolution.credential.mockResolvedValue(anthropicCredential);
    resolution.value.mockResolvedValue("sk-ant-api-key");
    process.env.ANTHROPIC_API_BASE_URL = await startModelFake(() => ({
      status: 401,
      body: { error: "bad key" },
    }));

    await expect(chooseReaction(AGENT)).resolves.toBe(FALLBACK_REACTION);
  });

  it("clamps the message text the model sees to 500 characters", async () => {
    resolution.credential.mockResolvedValue(anthropicCredential);
    resolution.value.mockResolvedValue("sk-ant-api-key");
    process.env.ANTHROPIC_API_BASE_URL = await startModelFake(() => ({
      body: { content: [{ type: "text", text: "eyes" }] },
    }));

    await chooseReaction({ ...AGENT, text: "x".repeat(5_000) });
    const body = requests[0]?.body as {
      messages: { content: string }[];
    };
    const messageLine = body.messages[0]!.content.split("\n").at(-1)!;
    expect(messageLine.length).toBeLessThanOrEqual("Message: ".length + 500);
  });

  it("sends OAuth-mode anthropic credentials as a Bearer with the oauth beta header", async () => {
    resolution.credential.mockResolvedValue({
      ...anthropicCredential,
      authMode: "oauth",
    });
    resolution.value.mockResolvedValue("sk-ant-oat-token");
    process.env.ANTHROPIC_API_BASE_URL = await startModelFake(() => ({
      body: { content: [{ type: "text", text: "eyes" }] },
    }));

    await chooseReaction(AGENT);
    expect(requests[0]?.headers.authorization).toBe("Bearer sk-ant-oat-token");
    expect(requests[0]?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(requests[0]?.headers["x-api-key"]).toBeUndefined();
  });
});
