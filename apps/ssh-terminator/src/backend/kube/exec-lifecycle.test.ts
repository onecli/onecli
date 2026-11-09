import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { V1Status } from "@kubernetes/client-node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecDisconnectedError } from "../types";
import { createKubeExecBackend, type KubeExecTarget } from "./exec-backend";

/**
 * The kube exec-backend's exit lifecycle: `exited` settles exactly once, with
 * whichever comes first of the exec status, a transport error, or a close.
 * The pods/exec client is replaced by a fake that hands the test the status
 * callback and the WebSocket.
 */

class FakeSocket extends EventEmitter {
  closes = 0;
  ping(): void {}
  close(): void {
    this.closes += 1;
  }
}

const dialed: {
  socket: FakeSocket;
  onStatus: (status: V1Status) => void;
}[] = [];

vi.mock("@kubernetes/client-node", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@kubernetes/client-node")>();
  class FakeExec {
    exec(
      _namespace: string,
      _pod: string,
      _container: string,
      _command: string[],
      _stdout: unknown,
      _stderr: unknown,
      _stdin: unknown,
      _tty: boolean,
      onStatus: (status: V1Status) => void,
    ): Promise<FakeSocket> {
      const socket = new FakeSocket();
      dialed.push({ socket, onStatus });
      return Promise.resolve(socket);
    }
  }
  return { ...actual, Exec: FakeExec };
});

const TARGET: KubeExecTarget = {
  namespace: "ns",
  pod: "pod",
  container: "agent",
  token: "token",
  server: "https://127.0.0.1:6443",
  caFile: "/dev/null",
};

const open = async () => {
  const handle = await createKubeExecBackend().exec(
    TARGET,
    { kind: "shell" },
    {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
    },
    false,
  );
  const dial = dialed.at(-1);
  if (!dial) throw new Error("exec was not dialed");
  return { handle, ...dial };
};

const nonZero = (code: string): V1Status => ({
  status: "Failure",
  reason: "NonZeroExitCode",
  details: { causes: [{ reason: "ExitCode", message: code }] },
});

beforeEach(() => {
  dialed.length = 0;
});

describe("createKubeExecBackend — exit lifecycle", () => {
  it("resolves the exit status, and the close that follows changes nothing", async () => {
    const { handle, socket, onStatus } = await open();
    onStatus(nonZero("7"));
    socket.emit("close");
    socket.emit("error", new Error("late"));
    await expect(handle.exited).resolves.toBe(7);
  });

  it("keeps the first exit status when another arrives", async () => {
    const { handle, onStatus } = await open();
    onStatus({ status: "Success" });
    onStatus(nonZero("3"));
    await expect(handle.exited).resolves.toBe(0);
  });

  it("rejects a close before any status, and ignores a late status", async () => {
    const { handle, socket, onStatus } = await open();
    socket.emit("close");
    onStatus({ status: "Success" });
    const error = await handle.exited.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecDisconnectedError);
    expect((error as Error).message).toBe("exec transport closed");
  });

  it("rejects a transport error with its message, and the close after it keeps it", async () => {
    const { handle, socket, onStatus } = await open();
    socket.emit("error", new Error("boom"));
    socket.emit("close");
    onStatus({ status: "Success" });
    const error = await handle.exited.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecDisconnectedError);
    expect((error as Error).message).toBe("exec transport error: boom");
  });

  it("dispose() closes the socket, every time it is called", async () => {
    const { handle, socket } = await open();
    handle.dispose();
    handle.dispose();
    expect(socket.closes).toBe(2);
  });
});
