import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof";

// Pinned onprem: secrets are created through the real createSecret, whose
// auto-attach runs the self-host grant path (see llm-autoattach-service's
// proof suite for the same pin).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

/**
 * The shared server-side key, and the eval judge on top of it, on REAL
 * PostgreSQL. Keys are created through the real `createSecret` (encrypted
 * at rest, auto-attached as a grant), resolved through the real fence
 * (`injectableSecretWhere` → `resolveAgentLlmCredential` →
 * `readLlmCredentialValue`), and spent against a local provider endpoint.
 *
 * Laws, each with its planted negative control:
 *  - the judge spends exactly the agent's own key, in the key's own shape
 *    (a Claude subscription carries the Claude Code identity block first);
 *  - another org's key is never reachable (cross-tenant control);
 *  - an agent with no key, and a ChatGPT login, make no provider call, and
 *    the login is never decrypted.
 */

const PROOF_URL = proofDatabaseUrl();

const P = "ldc-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_ORG = `${P}other-org`;
const OTHER_WORKSPACE = `${P}other-ws`;
const AGENT = `${P}agent`;
const FOREIGN_AGENT = `${P}foreign-agent`;

const VERDICT = {
  criteria: [{ criterion: "Says 51", met: true, note: "“51”" }],
  passed: true,
  summary: "Correct.",
};
const QUESTION = {
  question: "What is 17 x 3?",
  criteria: "- Says 51",
  answer: "51",
};

type Db = typeof import("@onecli/db").db;
let db: Db;
let secrets: typeof import("./secret-service");
let direct: typeof import("./llm-direct-call");
let judge: typeof import("./eval-judge");
const decrypted: string[] = [];

interface Seen {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: { system?: { text: string }[] };
}
let server: Server | undefined;
let seen: Seen[] = [];

const startProvider = async (): Promise<string> => {
  seen = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({
        path: req.url ?? "/",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(VERDICT) }],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.secret.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
};

const makeAgent = (id: string, workspaceId: string) =>
  db.agent.create({
    data: {
      id,
      workspaceId,
      name: id,
      identifier: id,
      accessToken: `aoc_${id}_token`,
    },
  });

const addKey = (
  workspaceId: string,
  type: "anthropic" | "openai",
  value: string,
) =>
  secrets.createSecret(
    { workspaceId },
    {
      name: `${type} key`,
      type,
      value,
      hostPattern: type === "openai" ? "api.openai.com" : "api.anthropic.com",
    },
  );

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  secrets = await import("./secret-service");
  direct = await import("./llm-direct-call");
  judge = await import("./eval-judge");
  const providers = await import("../providers");
  providers.initCrypto({
    encrypt: async (v: string) => `enc:${v}`,
    decrypt: async (v: string) => {
      decrypted.push(v);
      return v.replace(/^enc:/, "");
    },
  });
  await reset();
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  for (const id of [ORG, OTHER_ORG])
    await db.organization.create({ data: { id, name: id, slug: id } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.workspace.create({
    data: {
      id: OTHER_WORKSPACE,
      name: OTHER_WORKSPACE,
      organizationId: OTHER_ORG,
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  const providers = await import("../providers");
  providers.initRuleActionGate({ assertAllowed: async () => {} });
  providers.initPolicyValidator({ validate: async () => {} });
  await reset();
  decrypted.length = 0;
  await makeAgent(AGENT, WORKSPACE);
  await makeAgent(FOREIGN_AGENT, OTHER_WORKSPACE);
  process.env.ANTHROPIC_API_BASE_URL = await startProvider();
});

afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.ANTHROPIC_API_BASE_URL;
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("server-side LLM key over real PostgreSQL", () => {
  it("judges with the agent's own Claude subscription, identity block first", async () => {
    await addKey(WORKSPACE, "anthropic", "sk-ant-oat01-proof");
    const outcome = await judge.judgeAnswer({
      agent: { id: AGENT, workspaceId: WORKSPACE },
      organizationId: ORG,
      model: null,
      ...QUESTION,
    });
    expect(outcome).toEqual({
      ok: true,
      judgement: { ...VERDICT, model: "claude-sonnet-5" },
    });
    const [sent] = seen;
    expect(sent?.path).toBe("/v1/messages");
    expect(sent?.headers.authorization).toBe("Bearer sk-ant-oat01-proof");
    expect(sent?.headers["x-api-key"]).toBeUndefined();
    expect(sent?.body.system?.[0]?.text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });

  it("an Anthropic API key goes as x-api-key, with no identity block", async () => {
    await addKey(WORKSPACE, "anthropic", "sk-ant-api03-proof");
    expect(
      (
        await judge.judgeAnswer({
          agent: { id: AGENT, workspaceId: WORKSPACE },
          organizationId: ORG,
          model: null,
          ...QUESTION,
        })
      ).ok,
    ).toBe(true);
    expect(seen[0]?.headers["x-api-key"]).toBe("sk-ant-api03-proof");
    expect(seen[0]?.body.system?.[0]?.text).toContain("strict, fair grader");
  });

  it("another org's key is never reachable: no key, no call", async () => {
    // Planted cross-tenant control: the only key lives in another org.
    await addKey(OTHER_WORKSPACE, "anthropic", "sk-ant-api03-foreign");
    expect(
      await direct.resolveLlmCallKey(
        { id: AGENT, workspaceId: WORKSPACE },
        ORG,
      ),
    ).toEqual({ ok: false, reason: "missing" });
    expect(
      await judge.judgeAnswer({
        agent: { id: AGENT, workspaceId: WORKSPACE },
        organizationId: ORG,
        model: null,
        ...QUESTION,
      }),
    ).toEqual({ ok: false, error: "The agent has no model key to judge with" });
    expect(seen).toHaveLength(0);
    // The foreign key is real and usable by its own agent.
    expect(
      await direct.resolveLlmCallKey(
        { id: FOREIGN_AGENT, workspaceId: OTHER_WORKSPACE },
        OTHER_ORG,
      ),
    ).toMatchObject({ ok: true, key: { value: "sk-ant-api03-foreign" } });
  });

  it("a ChatGPT login is refused without a call and without decrypting it", async () => {
    await addKey(
      WORKSPACE,
      "openai",
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "proof-access",
          refresh_token: "proof-refresh",
          account_id: "acct-proof",
        },
      }),
    );
    expect(
      await judge.judgeAnswer({
        agent: { id: AGENT, workspaceId: WORKSPACE },
        organizationId: ORG,
        model: null,
        ...QUESTION,
      }),
    ).toEqual({
      ok: false,
      error:
        "The agent's ChatGPT login cannot be used to judge (an OpenAI API key or an Anthropic key can)",
    });
    expect(seen).toHaveLength(0);
    expect(decrypted).toHaveLength(0);
  });
});
