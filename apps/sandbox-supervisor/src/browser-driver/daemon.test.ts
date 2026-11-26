import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DaemonAlreadyRunning,
  HOLD_MESSAGE,
  startDaemon,
  type Daemon,
} from "./daemon";
import type { Reply, Request } from "./protocol";

const sendRaw = (socketPath: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let answered = false;
    socket.once("error", reject);
    // A connection the daemon dropped without a reply (a stop while this
    // request was still running) settles too, as the real command's does.
    socket.once("close", () => {
      if (!answered) reject(new Error("connection closed without a reply"));
    });
    socket.once("connect", () => {
      socket.write(`${line}\n`);
      createInterface({ input: socket }).once("line", (reply) => {
        answered = true;
        socket.end();
        resolve(reply);
      });
    });
  });

const send = async (socketPath: string, request: Request): Promise<Reply> =>
  JSON.parse(await sendRaw(socketPath, JSON.stringify(request))) as Reply;

describe("browser driver daemon", () => {
  let dir: string;
  let socketPath: string;
  let holdPath: string;
  let daemon: Daemon | null = null;
  const handled: Request[] = [];
  let shutdowns = 0;

  const handle = vi.fn(async (request: Request): Promise<Reply> => {
    handled.push(request);
    return { ok: true, url: `handled:${request.verb}`, title: "" };
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onecli-browser-"));
    socketPath = join(dir, "state", "browser.sock");
    holdPath = join(dir, "state", "browser.hold");
    handled.length = 0;
    shutdowns = 0;
    handle.mockClear();
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (idleMs?: number) => {
    daemon = await startDaemon({
      socketPath,
      holdPath,
      ...(idleMs !== undefined ? { idleMs } : {}),
      handle,
      shutdown: async () => {
        shutdowns += 1;
      },
    });
    return daemon;
  };

  it("listens on a 0600 socket in a 0700 directory it creates", async () => {
    await start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
  });

  it("routes a valid request to the handler and relays its reply", async () => {
    await start();
    const reply = await send(socketPath, { verb: "read" });
    expect(reply).toEqual({ ok: true, url: "handled:read", title: "" });
    expect(handled).toEqual([{ verb: "read" }]);
  });

  it("rejects malformed and unknown requests without calling the handler", async () => {
    await start();
    expect(JSON.parse(await sendRaw(socketPath, "not json")) as Reply).toEqual({
      ok: false,
      error: "request is not JSON",
    });
    const unknown = JSON.parse(
      await sendRaw(socketPath, JSON.stringify({ verb: "nuke" })),
    ) as Reply;
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/^bad request: /);
    // A target is a ref or a role and a name, never a CSS selector, never
    // both, never a role the snapshot could not print.
    for (const [target, error] of [
      [{ ref: "div.button" }, "a ref looks like e12"],
      [{ role: "Button", name: "Send" }, "a role looks like button"],
      [{ role: "button", name: "" }, "target.name"],
      [
        { ref: "e1", role: "button", name: "Send" },
        'a target is a ref (e12) or a role and a name (button "Send")',
      ],
      [{ name: "Send" }, "a target is a ref"],
    ] as const) {
      const reply = JSON.parse(
        await sendRaw(socketPath, JSON.stringify({ verb: "click", target })),
      ) as Reply;
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error).toContain(error);
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it("refuses an oversized request before a newline ever arrives", async () => {
    await start();
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("error", reject);
      socket.once("connect", () => {
        // Half a megabyte with no newline: a client that streams forever.
        socket.write("x".repeat(512 * 1024));
      });
      let got = "";
      socket.on("data", (chunk: Buffer) => {
        got += chunk.toString();
        if (got.includes("\n")) {
          socket.destroy();
          resolve(got.trim());
        }
      });
    });
    expect(JSON.parse(reply) as Reply).toEqual({
      ok: false,
      error: "request too large",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("serves requests one at a time, in order", async () => {
    await start();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handle.mockImplementationOnce(async (request) => {
      await gate;
      handled.push(request);
      return { ok: true, url: "slow", title: "" };
    });
    const first = send(socketPath, { verb: "snapshot" });
    const second = send(socketPath, { verb: "read" });
    await new Promise((r) => setTimeout(r, 50));
    expect(handled).toEqual([]); // the second waits behind the first
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(handled.map((r) => r.verb)).toEqual(["snapshot", "read"]);
  });

  it("keeps serving after a handler throws", async () => {
    await start();
    handle.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    expect(await send(socketPath, { verb: "read" })).toEqual({
      ok: false,
      error: "boom",
    });
    expect((await send(socketPath, { verb: "read" })).ok).toBe(true);
  });

  it("refuses every verb while the hold marker exists, looking included", async () => {
    await start();
    writeFileSync(holdPath, "");
    for (const request of [
      { verb: "click", target: { ref: "e1" } },
      { verb: "open", url: "https://example.com" },
      { verb: "snapshot" },
      { verb: "screenshot" },
      { verb: "read" },
    ] as const) {
      expect(await send(socketPath, request)).toEqual({
        ok: false,
        error: HOLD_MESSAGE,
      });
    }
    expect(handle).not.toHaveBeenCalled();
    rmSync(holdPath);
    expect(
      (await send(socketPath, { verb: "click", target: { ref: "e1" } })).ok,
    ).toBe(true);
  });

  it("still answers stop while a person holds the screen", async () => {
    await start();
    writeFileSync(holdPath, "");
    expect((await send(socketPath, { verb: "stop" })).ok).toBe(true);
    await vi.waitFor(() => expect(shutdowns).toBe(1));
  });

  it("answers stop ahead of a verb that is still running", async () => {
    await start();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handle.mockImplementationOnce(async (request) => {
      await gate;
      handled.push(request);
      return { ok: true, url: "stuck", title: "" };
    });
    const stuck = send(socketPath, { verb: "read" });
    await new Promise((r) => setTimeout(r, 30));
    // stop does not wait behind the stuck verb
    expect((await send(socketPath, { verb: "stop" })).ok).toBe(true);
    await vi.waitFor(() => expect(shutdowns).toBe(1));
    release();
    await stuck.catch(() => undefined); // the socket may be gone; either way, no hang
  });

  it("answers stop, then shuts down and removes the socket", async () => {
    await start();
    expect((await send(socketPath, { verb: "stop" })).ok).toBe(true);
    await vi.waitFor(() => expect(shutdowns).toBe(1));
    expect(() => statSync(socketPath)).toThrow();
    expect(handle).not.toHaveBeenCalled();
  });

  it("a second daemon on the same socket refuses to start while the first lives, and the first keeps serving", async () => {
    await start();
    await expect(
      startDaemon({
        socketPath,
        holdPath,
        handle,
        shutdown: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunning);
    expect((await send(socketPath, { verb: "read" })).ok).toBe(true);
  });

  it("a lock a dead daemon left is taken over", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "browser.sock.lock"), "999999999");
    await start();
    expect((await send(socketPath, { verb: "read" })).ok).toBe(true);
    expect(readFileSync(join(dir, "state", "browser.sock.lock"), "utf8")).toBe(
      String(process.pid),
    );
  });

  it("stop removes the lock with the socket", async () => {
    await start();
    expect((await send(socketPath, { verb: "stop" })).ok).toBe(true);
    await vi.waitFor(() => expect(shutdowns).toBe(1));
    expect(() => statSync(join(dir, "state", "browser.sock.lock"))).toThrow();
  });

  it("exits on its own after sitting idle", async () => {
    await start(80);
    await send(socketPath, { verb: "read" });
    await vi.waitFor(() => expect(shutdowns).toBe(1), { timeout: 2_000 });
    expect(() => statSync(socketPath)).toThrow();
  });
});
