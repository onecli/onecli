import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof";

// Pinned onprem: createSecret's auto-attach runs the self-host grant path (see
// llm-direct-call.pg.test.ts for the same pin).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

/**
 * Keeper-sourced secrets (`valueSource: "keepersecurity"`) on REAL PostgreSQL.
 *
 * Laws, each with a planted negative control:
 *  - a Keeper secret stores the reference and NO value: `encryptedValue` is null
 *    and the crypto provider is never asked to encrypt;
 *  - switching a secret between sources clears the other source's column, so a
 *    row never carries two competing sources;
 *  - Keeper is workspace-scoped only (an org secret has no single connection);
 *  - a Keeper secret cannot be created or switched to without a reference;
 *  - another workspace's secret is unreachable from this one.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

const P = "ksp-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_ORG = `${P}other-org`;
const OTHER_WORKSPACE = `${P}other-ws`;
const REF = "keeper://qnXEdBFVi2Gm1UFehAsjew/field/password";
const REF2 = "keeper://AAAAAAAAAAAAAAAAAAAAAA/field/login";
const INJECT = { headerName: "Authorization", valueFormat: "Bearer {value}" };

type Db = typeof import("@onecli/db").db;
let db: Db;
let secrets: typeof import("./secret-service");
const encrypted: string[] = [];

const reset = async () => {
  await db.secret.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
};

const keepersecuritySecret = (extra: Record<string, unknown> = {}) =>
  secrets.createSecret({ workspaceId: WORKSPACE }, {
    name: "Keeper token",
    type: "generic",
    valueSource: "keepersecurity",
    keepersecurityRef: REF,
    hostPattern: "api.example.com",
    injectionConfig: INJECT,
    ...extra,
  } as never);

const row = (id: string) => db.secret.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  secrets = await import("./secret-service");
  const providers = await import("../providers");
  providers.initCrypto({
    encrypt: async (v: string) => {
      encrypted.push(v);
      return `enc:${v}`;
    },
    decrypt: async (v: string) => v.replace(/^enc:/, ""),
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
  await reset();
  encrypted.length = 0;
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)(
  "Keeper-sourced secrets over real PostgreSQL",
  () => {
    describe("create", () => {
      it("stores the reference and no value", async () => {
        const created = await keepersecuritySecret();
        expect(created).toMatchObject({
          valueSource: "keepersecurity",
          keepersecurityRef: REF,
          hostPattern: "api.example.com",
        });
        const stored = await row(created.id);
        expect(stored.valueSource).toBe("keepersecurity");
        expect(stored.encryptedValue).toBeNull();
        expect(stored.keepersecurityRef).toBe(REF);
        expect(stored.opRef).toBeNull();
        expect(encrypted).toEqual([]); // nothing was ever encrypted
      });

      it("keeps the injection config for a custom connection", async () => {
        const created = await keepersecuritySecret({
          injectionConfig: { headerName: "X-Api-Key", valueFormat: "{value}" },
        });
        expect((await row(created.id)).injectionConfig).toMatchObject({
          headerName: "X-Api-Key",
        });
      });

      it("pins an Anthropic key to its provider host, as an API key", async () => {
        const created = await keepersecuritySecret({
          type: "anthropic",
          hostPattern: "evil.example.com",
        });
        const stored = await row(created.id);
        expect(stored.hostPattern).toBe("api.anthropic.com");
        expect(stored.metadata).toEqual({ authMode: "api-key" });
      });

      it("pins an OpenAI key to its provider host", async () => {
        const created = await keepersecuritySecret({
          type: "openai",
          hostPattern: "x.example.com",
        });
        expect((await row(created.id)).hostPattern).toBe("api.openai.com");
      });

      it("refuses to create without a reference", async () => {
        await expect(
          keepersecuritySecret({ keepersecurityRef: undefined }),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
        });
        expect(
          await db.secret.count({ where: { workspaceId: WORKSPACE } }),
        ).toBe(0);
      });

      it("refuses an organisation-scoped Keeper secret (no single connection to resolve through)", async () => {
        await expect(
          secrets.createSecret({ organizationId: ORG }, {
            name: "org keepersecurity",
            type: "generic",
            valueSource: "keepersecurity",
            keepersecurityRef: REF,
            hostPattern: "api.example.com",
            injectionConfig: INJECT,
          } as never),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringContaining("workspace-scoped"),
        });
        expect(await db.secret.count({ where: { organizationId: ORG } })).toBe(
          0,
        );
      });

      it("accepts a path-injected Keeper secret without inspecting a value it does not hold", async () => {
        const created = await keepersecuritySecret({
          injectionConfig: { pathTemplate: "/v1/{value}/data" },
        });
        expect((await row(created.id)).valueSource).toBe("keepersecurity");
      });

      it("control: an inline secret still encrypts its value and stores no reference", async () => {
        const created = await secrets.createSecret({ workspaceId: WORKSPACE }, {
          name: "inline",
          type: "generic",
          value: "plain-value",
          hostPattern: "api.example.com",
          injectionConfig: INJECT,
        } as never);
        const stored = await row(created.id);
        expect(stored.valueSource).toBe("inline");
        expect(stored.encryptedValue).toBe("enc:plain-value");
        expect(stored.keepersecurityRef).toBeNull();
        expect(encrypted).toEqual(["plain-value"]);
      });
    });

    describe("list", () => {
      it("returns the reference, never a value", async () => {
        await keepersecuritySecret();
        const [item] = await secrets.listSecrets({ workspaceId: WORKSPACE });
        expect(item).toMatchObject({
          valueSource: "keepersecurity",
          keepersecurityRef: REF,
        });
        expect(JSON.stringify(item)).not.toContain('encryptedValue":"');
      });
    });

    describe("picker labels", () => {
      const DISPLAY = { record: "GitHub", field: "Password", folder: "Shared" };

      it("stores the picked record/field labels alongside the reference", async () => {
        const created = await keepersecuritySecret({
          keepersecurityDisplay: DISPLAY,
        });
        expect((await row(created.id)).metadata).toEqual({
          keepersecurityDisplay: DISPLAY,
        });
      });

      it("keeps an LLM key in API-key mode next to the labels", async () => {
        const created = await keepersecuritySecret({
          type: "anthropic",
          keepersecurityDisplay: DISPLAY,
        });
        expect((await row(created.id)).metadata).toEqual({
          authMode: "api-key",
          keepersecurityDisplay: DISPLAY,
        });
      });

      it("replaces the labels when a different field is picked", async () => {
        const created = await keepersecuritySecret({
          keepersecurityDisplay: DISPLAY,
        });
        const next = { record: "GitHub", field: "API Key" };
        await secrets.updateSecret({ workspaceId: WORKSPACE }, created.id, {
          valueSource: "keepersecurity",
          keepersecurityRef:
            "keeper://qnXEdBFVi2Gm1UFehAsjew/custom_field/API Key",
          keepersecurityDisplay: next,
        } as never);
        expect((await row(created.id)).metadata).toEqual({
          keepersecurityDisplay: next,
        });
      });

      it("drops stale labels when the reference is typed by hand", async () => {
        const created = await keepersecuritySecret({
          keepersecurityDisplay: DISPLAY,
        });
        await secrets.updateSecret({ workspaceId: WORKSPACE }, created.id, {
          valueSource: "keepersecurity",
          keepersecurityRef: "keeper://AAAAAAAAAAAAAAAAAAAAAA/field/login",
        } as never);
        expect((await row(created.id)).metadata).toBeNull();
      });
    });

    describe("update: switching sources", () => {
      it("inline → Keeper clears the stored value", async () => {
        const inline = await secrets.createSecret({ workspaceId: WORKSPACE }, {
          name: "was inline",
          type: "generic",
          value: "old-plain",
          hostPattern: "api.example.com",
          injectionConfig: INJECT,
        } as never);
        await secrets.updateSecret({ workspaceId: WORKSPACE }, inline.id, {
          valueSource: "keepersecurity",
          keepersecurityRef: REF,
        } as never);
        const stored = await row(inline.id);
        expect(stored).toMatchObject({
          valueSource: "keepersecurity",
          keepersecurityRef: REF,
          encryptedValue: null,
          opRef: null,
        });
      });

      it("Keeper → inline clears the reference", async () => {
        const created = await keepersecuritySecret();
        await secrets.updateSecret({ workspaceId: WORKSPACE }, created.id, {
          valueSource: "inline",
          value: "now-plain",
        } as never);
        const stored = await row(created.id);
        expect(stored).toMatchObject({
          valueSource: "inline",
          encryptedValue: "enc:now-plain",
          keepersecurityRef: null,
        });
      });

      it("1Password → Keeper clears the 1Password reference", async () => {
        const op = await secrets.createSecret({ workspaceId: WORKSPACE }, {
          name: "was 1password",
          type: "generic",
          valueSource: "onepassword",
          opRef: "op://vault/item/field",
          hostPattern: "api.example.com",
          injectionConfig: INJECT,
        } as never);
        await secrets.updateSecret({ workspaceId: WORKSPACE }, op.id, {
          valueSource: "keepersecurity",
          keepersecurityRef: REF,
        } as never);
        expect(await row(op.id)).toMatchObject({
          valueSource: "keepersecurity",
          keepersecurityRef: REF,
          opRef: null,
        });
      });

      it("Keeper → 1Password clears the Keeper reference", async () => {
        const created = await keepersecuritySecret();
        await secrets.updateSecret({ workspaceId: WORKSPACE }, created.id, {
          valueSource: "onepassword",
          opRef: "op://vault/item/field",
        } as never);
        expect(await row(created.id)).toMatchObject({
          valueSource: "onepassword",
          opRef: "op://vault/item/field",
          keepersecurityRef: null,
        });
      });

      it("re-points an existing Keeper secret at another record", async () => {
        const created = await keepersecuritySecret();
        await secrets.updateSecret({ workspaceId: WORKSPACE }, created.id, {
          valueSource: "keepersecurity",
          keepersecurityRef: REF2,
        } as never);
        expect((await row(created.id)).keepersecurityRef).toBe(REF2);
      });

      it("refuses to switch to Keeper without a reference, leaving the row untouched", async () => {
        const inline = await secrets.createSecret({ workspaceId: WORKSPACE }, {
          name: "stay inline",
          type: "generic",
          value: "keep-me",
          hostPattern: "api.example.com",
          injectionConfig: INJECT,
        } as never);
        await expect(
          secrets.updateSecret({ workspaceId: WORKSPACE }, inline.id, {
            valueSource: "keepersecurity",
          } as never),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringContaining("keepersecurity reference"),
        });
        expect(await row(inline.id)).toMatchObject({
          valueSource: "inline",
          encryptedValue: "enc:keep-me",
          keepersecurityRef: null,
        });
      });

      it("refuses to switch an organisation secret to Keeper", async () => {
        const orgSecret = await secrets.createSecret({ organizationId: ORG }, {
          name: "org inline",
          type: "generic",
          value: "org-value",
          hostPattern: "api.example.com",
          injectionConfig: INJECT,
        } as never);
        await expect(
          secrets.updateSecret({ organizationId: ORG }, orgSecret.id, {
            valueSource: "keepersecurity",
            keepersecurityRef: REF,
          } as never),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringContaining("workspace-scoped"),
        });
        await db.secret.deleteMany({ where: { organizationId: ORG } });
      });
    });

    describe("tenant fence", () => {
      it("another workspace cannot update this workspace's Keeper secret", async () => {
        const created = await keepersecuritySecret();
        await expect(
          secrets.updateSecret({ workspaceId: OTHER_WORKSPACE }, created.id, {
            valueSource: "keepersecurity",
            keepersecurityRef: REF2,
          } as never),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect((await row(created.id)).keepersecurityRef).toBe(REF);
      });

      it("another workspace does not see this workspace's Keeper secret", async () => {
        await keepersecuritySecret();
        expect(
          await secrets.listSecrets({ workspaceId: OTHER_WORKSPACE }),
        ).toEqual([]);
      });
    });
  },
);
