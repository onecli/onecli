import { describe, expect, it } from "vitest";
import { signGrant } from "@onecli/ssh-cert";
import { ResolverRefusedError, ResolverUnreachableError } from "../types";
import {
  createTestCa,
  createTestUserKey,
  mintTestCertificate,
  type TestCa,
} from "../../test-fixtures";
import type { ContainerSummary, DockerEngineApi } from "./engine-api";
import { DockerEngineError } from "./engine-api";
import { createDockerResolver } from "./resolver";

/**
 * The docker resolver's law: verify BOTH signed artifacts in-process (the
 * kube broker's five checks, mirrored), then resolve by label — zero
 * running matches is "waking", exactly one is ready, more is a refusal.
 */

const signTestGrant = (
  ca: TestCa,
  overrides: Partial<{
    sessionId: string;
    agentId: string;
    sandboxId: string;
    workspaceId: string;
  }> = {},
): Promise<string> =>
  signGrant(
    {
      sessionId: "sess-1",
      agentId: "agent-1",
      sandboxId: "sbx-1",
      workspaceId: "ws-1",
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 600),
      ...overrides,
    },
    ca.signer,
  );

interface FakeEngine extends DockerEngineApi {
  listed: string[][];
  listBehavior: () => Promise<ContainerSummary[]>;
}

const makeEngine = (): FakeEngine => {
  const fake: FakeEngine = {
    listed: [],
    listBehavior: () => Promise.resolve([{ Id: "container-1" }]),
    negotiateVersion: () => Promise.resolve("1.44"),
    listContainers(labels) {
      fake.listed.push(labels);
      return fake.listBehavior();
    },
    execCreate: () => Promise.reject(new Error("not under test")),
    execStart: () => Promise.reject(new Error("not under test")),
    execResize: () => Promise.resolve(),
    execInspect: () => Promise.reject(new Error("not under test")),
    close: () => Promise.resolve(),
  };
  return fake;
};

const harness = async () => {
  const ca = createTestCa();
  const user = createTestUserKey();
  const built = await mintTestCertificate(ca, user);
  const grant = await signTestGrant(ca);
  const engine = makeEngine();
  const resolver = createDockerResolver({
    engine,
    caPublicKey: ca.publicKey,
  });
  return { ca, user, certificate: built.line, grant, engine, resolver };
};

describe("createDockerResolver — verification law", () => {
  it("resolves a valid pair to the labeled running container", async () => {
    const h = await harness();
    const answer = await h.resolver.open({
      certificate: h.certificate,
      grant: h.grant,
    });
    expect(answer.status).toBe("ready");
    if (answer.status !== "ready") throw new Error("expected ready");
    expect(answer.target.containerId).toBe("container-1");
    expect(answer.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(h.engine.listed[0]).toEqual([
      "sh.onecli.managed=1",
      "sh.onecli.sandbox-id=sbx-1",
    ]);
  });

  it("refuses a grant signed by a foreign CA", async () => {
    const h = await harness();
    const foreign = createTestCa();
    const forgedGrant = await signTestGrant(foreign);
    await expect(
      h.resolver.open({ certificate: h.certificate, grant: forgedGrant }),
    ).rejects.toMatchObject({ code: "grant_refused" });
    // Refusal happens BEFORE any daemon call — no lookup ever ran.
    expect(h.engine.listed).toHaveLength(0);
  });

  it("refuses an expired grant", async () => {
    const h = await harness();
    const expired = await signGrant(
      {
        sessionId: "sess-1",
        agentId: "agent-1",
        sandboxId: "sbx-1",
        workspaceId: "ws-1",
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
      },
      h.ca.signer,
    );
    await expect(
      h.resolver.open({ certificate: h.certificate, grant: expired }),
    ).rejects.toMatchObject({ code: "grant_refused" });
  });

  it("refuses a malformed certificate as cert_refused, never a crash", async () => {
    const h = await harness();
    await expect(
      h.resolver.open({ certificate: "not a certificate", grant: h.grant }),
    ).rejects.toMatchObject({ code: "cert_refused" });
  });

  it("refuses a certificate from a foreign CA", async () => {
    const h = await harness();
    const foreign = createTestCa();
    const foreignUser = createTestUserKey();
    const foreignCert = await mintTestCertificate(foreign, foreignUser);
    await expect(
      h.resolver.open({ certificate: foreignCert.line, grant: h.grant }),
    ).rejects.toMatchObject({ code: "cert_refused" });
  });

  it("accepts a cert past its validity window (the grant bounds the session)", async () => {
    const h = await harness();
    const user = createTestUserKey();
    const stale = await mintTestCertificate(h.ca, user, {
      validAfter: new Date(Date.now() - 3_600_000),
      validBefore: new Date(Date.now() - 1_800_000),
    });
    const answer = await h.resolver.open({
      certificate: stale.line,
      grant: h.grant,
    });
    expect(answer.status).toBe("ready");
  });

  it("refuses a cert/grant subject mismatch as identity_mismatch", async () => {
    const h = await harness();
    const otherGrant = await signTestGrant(h.ca, { sandboxId: "sbx-other" });
    await expect(
      h.resolver.open({ certificate: h.certificate, grant: otherGrant }),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("refuses a grant with a mis-shaped id outright", async () => {
    const h = await harness();
    const hostile = await signTestGrant(h.ca, {
      sandboxId: 'sbx"]},{"evil":["x',
    });
    await expect(
      h.resolver.open({ certificate: h.certificate, grant: hostile }),
    ).rejects.toMatchObject({ code: "grant_refused" });
    expect(h.engine.listed).toHaveLength(0);
  });
});

describe("createDockerResolver — container resolution", () => {
  it("answers waking when no running container matches (the replace-window)", async () => {
    const h = await harness();
    h.engine.listBehavior = () => Promise.resolve([]);
    await expect(
      h.resolver.open({ certificate: h.certificate, grant: h.grant }),
    ).resolves.toEqual({ status: "waking" });
  });

  it("refuses deterministically when more than one container claims the sandbox", async () => {
    const h = await harness();
    h.engine.listBehavior = () => Promise.resolve([{ Id: "a" }, { Id: "b" }]);
    await expect(
      h.resolver.open({ certificate: h.certificate, grant: h.grant }),
    ).rejects.toMatchObject({ code: "ambiguous_container" });
  });

  it("maps a daemon failure to transport-class (the wake poll rides it out)", async () => {
    const h = await harness();
    h.engine.listBehavior = () =>
      Promise.reject(new DockerEngineError(500, "boom", "docker GET failed"));
    await expect(
      h.resolver.open({ certificate: h.certificate, grant: h.grant }),
    ).rejects.toBeInstanceOf(ResolverUnreachableError);
  });

  it("close is a no-op (no per-session substrate state)", async () => {
    const h = await harness();
    await expect(h.resolver.close("sess-1")).resolves.toBeUndefined();
  });
});

describe("createDockerResolver — refusal class", () => {
  it("every refusal is a ResolverRefusedError instance", async () => {
    const h = await harness();
    const failure = await h.resolver
      .open({ certificate: "garbage", grant: h.grant })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ResolverRefusedError);
  });
});
