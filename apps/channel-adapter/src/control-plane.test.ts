import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlaneError, createControlPlane } from "./control-plane";
import { waitReal } from "./test/fakes";

/**
 * The control-plane client against a real node:http server (the fakes.ts
 * way — real HTTP, no mocked modules): what these prove is the per-instance
 * identity protocol. Registration always presents the ANCHOR and adopts the
 * minted bearer; a 401 AFTER a successful mint is a displaced twin and
 * recovers exactly once under a self-suffixed name (single-flighted across
 * concurrent poll loops, re-armed for the next displacement); a 401 BEFORE
 * any registration is a real refusal — never a re-register.
 */

const ANCHOR = "cha_anchor";
const REGISTER = "/v1/channel-adapter/register";
const WORK = "/v1/channel-adapter/work";
const CONFIG = "/v1/channel-adapter/config";

interface RecordedCall {
  method: string;
  path: string;
  /** The bearer token the client presented. */
  bearer: string | null;
  /** The decoded JSON body (null on body-less requests). */
  body: unknown;
}

/** What the scripted handler answers — or "hold" to park the response (the
 * fake gateway's held-response trick, here for racing concurrent 401s). */
type ScriptedAnswer = { status: number; body: unknown } | "hold";

interface FakeControlPlaneServer {
  url: string;
  calls: RecordedCall[];
  callsTo: (path: string) => RecordedCall[];
  /** Decides every answer; assigned per test (reassignable mid-test). */
  respond: (call: RecordedCall) => ScriptedAnswer;
  /** Answer every currently-held request at once. */
  releaseHeld: (status: number, body: unknown) => void;
  heldCount: () => number;
  close: () => Promise<void>;
}

const startFakeControlPlaneServer =
  async (): Promise<FakeControlPlaneServer> => {
    const calls: RecordedCall[] = [];
    const held: ServerResponse[] = [];

    const answer = (
      res: ServerResponse,
      status: number,
      body: unknown,
    ): void => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    const server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        raw += chunk;
      });
      req.on("end", () => {
        const auth = req.headers.authorization;
        const call: RecordedCall = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          bearer: auth?.startsWith("Bearer ")
            ? auth.slice("Bearer ".length)
            : null,
          body: raw ? (JSON.parse(raw) as unknown) : null,
        };
        calls.push(call);
        const scripted = fake.respond(call);
        if (scripted === "hold") held.push(res);
        else answer(res, scripted.status, scripted.body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;

    const fake: FakeControlPlaneServer = {
      url: `http://127.0.0.1:${port}`,
      calls,
      callsTo: (path) => calls.filter((call) => call.path === path),
      // Unscripted calls fail loudly rather than vacuously succeeding.
      respond: () => ({ status: 500, body: { error: "unscripted" } }),
      releaseHeld: (status, body) => {
        for (const res of held.splice(0)) answer(res, status, body);
      },
      heldCount: () => held.length,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
    return fake;
  };

let server: FakeControlPlaneServer;

beforeEach(async () => {
  server = await startFakeControlPlaneServer();
});

afterEach(async () => {
  await server.close();
});

describe("registration adopts the per-instance mint", () => {
  it("registers with the ANCHOR and { name, perInstance: true }, then bears the mint", async () => {
    // The anchor is the membership proof — registration ALWAYS presents it —
    // and the minted token is this instance's identity from then on.
    server.respond = (call) =>
      call.path === REGISTER
        ? { status: 200, body: { adapterId: "ad-1", token: "cha_minted_1" } }
        : { status: 200, body: { finished: [] } };
    const client = createControlPlane({ baseUrl: server.url, token: ANCHOR });

    const adapterId = await client.register("adapter-a");
    expect(adapterId).toBe("ad-1");
    expect(server.callsTo(REGISTER)).toEqual([
      {
        method: "POST",
        path: REGISTER,
        bearer: ANCHOR,
        body: { name: "adapter-a", perInstance: true },
      },
    ]);

    await client.getWork();
    expect(server.callsTo(WORK)[0]?.bearer).toBe("cha_minted_1");
  });

  it("keeps the anchor as the bearer when an OLD control plane mints no token", async () => {
    // Version skew: an old server's register response has no `token` — the
    // anchor then stays the bearer (the legacy shared identity).
    server.respond = (call) =>
      call.path === REGISTER
        ? { status: 200, body: { adapterId: "ad-1" } }
        : { status: 200, body: { finished: [] } };
    const client = createControlPlane({ baseUrl: server.url, token: ANCHOR });

    await client.register("adapter-a");
    await client.getWork();
    expect(server.callsTo(WORK)[0]?.bearer).toBe(ANCHOR);
  });
});

describe("displaced-twin recovery", () => {
  it("recovers concurrent 401s through ONE suffix-named re-register", async () => {
    // A same-named twin re-registered and displaced this instance's mint;
    // two poll loops 401 together. Both must funnel into ONE re-register
    // (anchor bearer, the original name plus a 4-hex self-suffix — two live
    // twins converge to distinct rows, never a flip-flop storm), and both
    // retries ride the new mint. MUTATION-PROOF (single-flight): turn
    // `recovery ??=` into `recovery =` and BOTH loops re-register — the
    // exactly-two register count below fails.
    let minted = 0;
    server.respond = (call) => {
      if (call.path === REGISTER) {
        minted += 1;
        return {
          status: 200,
          body: { adapterId: `ad-${minted}`, token: `cha_minted_${minted}` },
        };
      }
      // The displaced mint: hold both polls so their 401s land together.
      if (call.bearer === "cha_minted_1") return "hold";
      return { status: 200, body: { finished: [] } };
    };
    const client = createControlPlane({ baseUrl: server.url, token: ANCHOR });
    await client.register("adapter-a");

    const loops = [client.getWork(), client.getWork()];
    await waitReal(() => server.heldCount() === 2, "both polls in flight");
    server.releaseHeld(401, { error: { code: "unauthorized" } });

    // Both loops settle on the retried call — the displacement is invisible
    // to the caller.
    expect(await Promise.all(loops)).toEqual([
      { finished: [] },
      { finished: [] },
    ]);

    const registers = server.callsTo(REGISTER);
    expect(registers).toHaveLength(2);
    expect(registers[1]?.bearer).toBe(ANCHOR);
    expect(registers[1]?.body).toMatchObject({ perInstance: true });
    expect((registers[1]?.body as { name: string }).name).toMatch(
      /^adapter-a-[0-9a-f]{4}$/,
    );

    // Every later call bears the newest mint.
    await client.getWork();
    expect(server.callsTo(WORK).at(-1)?.bearer).toBe("cha_minted_2");
  });

  it("treats a 401 BEFORE any registration as a real refusal — never a re-register", async () => {
    // A bad anchor must surface as ControlPlaneError(401), not spin into
    // registration attempts: before the first successful mint there is no
    // displaced identity to recover. Both 401 arms (call() and getConfig's
    // own) are pinned. MUTATION-PROOF (registeredName gate): drop the
    // `if (!baseName)` guard in recoverFromDisplacement and each 401 below
    // re-registers under a "null-…" name — the zero-register assertion fails.
    server.respond = () => ({ status: 401, body: { error: "bad anchor" } });
    const client = createControlPlane({ baseUrl: server.url, token: ANCHOR });

    const workError: unknown = await client
      .getWork()
      .catch((err: unknown) => err);
    expect(workError).toBeInstanceOf(ControlPlaneError);
    expect((workError as ControlPlaneError).status).toBe(401);

    const configError: unknown = await client
      .getConfig(null)
      .catch((err: unknown) => err);
    expect(configError).toBeInstanceOf(ControlPlaneError);
    expect((configError as ControlPlaneError).status).toBe(401);

    expect(server.callsTo(REGISTER)).toEqual([]);
    expect(server.callsTo(WORK)).toHaveLength(1);
    expect(server.callsTo(CONFIG)).toHaveLength(1);
  });

  it("recovers AGAIN on a second displacement — the latch resets after settling", async () => {
    // The single-flight promise clears once its recovery settles, so a
    // LATER displacement (another twin, another deploy overlap) recovers
    // too — each hop re-suffixing the last registered name.
    let minted = 0;
    const displaced = new Set<string>();
    server.respond = (call) => {
      if (call.path === REGISTER) {
        minted += 1;
        return {
          status: 200,
          body: { adapterId: `ad-${minted}`, token: `cha_minted_${minted}` },
        };
      }
      if (call.bearer !== null && displaced.has(call.bearer)) {
        return { status: 401, body: {} };
      }
      return { status: 200, body: { finished: [] } };
    };
    const client = createControlPlane({ baseUrl: server.url, token: ANCHOR });
    await client.register("adapter-a");

    // Displacement 1: the next poll recovers under mint 2.
    displaced.add("cha_minted_1");
    await client.getWork();
    expect(server.callsTo(WORK).at(-1)?.bearer).toBe("cha_minted_2");

    // Displacement 2, later: the settled latch has reset — recover again.
    displaced.add("cha_minted_2");
    await client.getWork();
    expect(server.callsTo(WORK).at(-1)?.bearer).toBe("cha_minted_3");

    // One suffix hop per displacement, layered on the LAST registered name.
    const names = server
      .callsTo(REGISTER)
      .map((call) => (call.body as { name: string }).name);
    expect(names[0]).toBe("adapter-a");
    expect(names[1]).toMatch(/^adapter-a-[0-9a-f]{4}$/);
    expect(names[2]).toMatch(new RegExp(`^${names[1]!}-[0-9a-f]{4}$`));
  });
});
