import { createServer, type Server, type Socket } from "node:net";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { requestSchema, type Reply, type Request } from "./protocol";
import { Driver } from "./driver";
import { environmentFromEnv } from "./launch";
import {
  agentHomeDir,
  browserHoldPath,
  browserOutputDir,
  browserSocketPath,
  browserStateDir,
} from "./paths";
import { withLoopbackUnproxied } from "./proxy-env";

/**
 * The driver daemon: one process per sandbox that keeps the browser
 * attached between commands, so a verb costs a socket round-trip and not a
 * process, a library load, and a CDP handshake.
 *
 * - Requests are served ONE AT A TIME, in arrival order. Two conversations
 *   acting on the same tab at once would race; a queue makes each verb's
 *   reply the state its own action left.
 * - Idle for IDLE_MS, the daemon exits. The browser and its profile stay;
 *   the next command starts a fresh daemon that attaches again.
 * - While the hold marker exists (a person has the screen), every verb but
 *   `stop` is refused with the one line the agent needs. Looking included:
 *   the person may be typing a password, and a snapshot carries field
 *   values.
 * - `stop` ends the daemon from the command. It is answered ahead of the
 *   queue, so a verb that wedged the page (the driver bounds those too)
 *   never stands between the agent and a clean restart.
 */

export const IDLE_MS = 10 * 60 * 1_000;
/** One request line is a verb and its arguments: never a page. */
const MAX_LINE_BYTES = 128 * 1_024;

export const HOLD_MESSAGE =
  "a person is using the screen; wait, you will be told when they are done";

export interface DaemonOptions {
  socketPath: string;
  holdPath: string;
  idleMs?: number;
  /** The verb handler; the real one is the Driver. */
  handle: (request: Request) => Promise<Reply>;
  /** Called on stop, idle, or SIGTERM, before exit. */
  shutdown: () => Promise<void>;
}

export interface Daemon {
  close(): Promise<void>;
}

export const startDaemon = async (options: DaemonOptions): Promise<Daemon> => {
  const idleMs = options.idleMs ?? IDLE_MS;
  let queue: Promise<unknown> = Promise.resolve();
  let idle: NodeJS.Timeout | undefined;
  let closing = false;
  const open = new Set<Socket>();

  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    serve(socket);
  });

  // The socket's lock (taken below), removed with the socket BEFORE
  // `shutdown` (which may end the process). Never removed unless held:
  // a loser of the start race must not take the winner's lock with it.
  const lockPath = `${options.socketPath}.lock`;
  let lockHeld = false;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    // Open connections are dropped, not drained: a verb still waiting on a
    // wedged page would otherwise hold the daemon (and the agent) here.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of open) socket.destroy();
    });
    rmSync(options.socketPath, { force: true });
    if (lockHeld) rmSync(lockPath, { force: true });
    await options.shutdown();
  };

  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => void close(), idleMs);
    idle.unref();
  };

  const answer = async (request: Request): Promise<Reply> => {
    if (existsSync(options.holdPath)) return { ok: false, error: HOLD_MESSAGE };
    return options.handle(request);
  };

  const serve = (socket: Socket) => {
    // Read up to the first newline, buffering no more than one request's
    // worth: a client that never sends a newline cannot grow memory here.
    let buffered = "";
    let done = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (done) return;
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        if (buffered.length > MAX_LINE_BYTES) {
          done = true;
          reply(socket, { ok: false, error: "request too large" });
        }
        return;
      }
      done = true;
      socket.pause();
      received(socket, buffered.slice(0, newline));
    });
    socket.on("error", () => undefined);
  };

  const received = (socket: Socket, line: string) => {
    let parsed: ReturnType<typeof requestSchema.safeParse>;
    try {
      parsed = requestSchema.safeParse(JSON.parse(line));
    } catch {
      reply(socket, { ok: false, error: "request is not JSON" });
      return;
    }
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      reply(socket, {
        ok: false,
        error: `bad request: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown verb"}`,
      });
      return;
    }
    const request = parsed.data;
    if (request.verb === "stop") {
      // Reply first, then go: the command is waiting on this line.
      reply(socket, { ok: true, url: "", title: "" });
      setImmediate(() => void close());
      return;
    }
    touch();
    // Serialized: this request runs after every earlier one, and a
    // failure in one never breaks the chain for the next.
    queue = queue
      .then(() => answer(request))
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        reply(socket, result);
        touch();
      });
  };

  mkdirSync(options.socketPath.slice(0, options.socketPath.lastIndexOf("/")), {
    recursive: true,
    mode: 0o700,
  });
  // One daemon per socket. Two cold-start commands spawn two daemons at
  // once; without this each would unlink the other's socket and listen,
  // leaving one orphan attached to the browser. The lock is a file opened
  // exclusively: the loser sees it and exits, and its command's retry
  // finds the winner's socket. A lock left by a daemon that died (the
  // container's last life) names a pid that is gone, and is taken over.
  if (!acquireLock(lockPath)) throw new DaemonAlreadyRunning();
  lockHeld = true;
  rmSync(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(options.socketPath, 0o600);
  touch();
  return { close };
};

/** Thrown by startDaemon when another live daemon holds the socket's lock. */
export class DaemonAlreadyRunning extends Error {
  constructor() {
    super("another browser driver is already running");
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Take the lock, or return false if a LIVE daemon holds it. */
const acquireLock = (path: string): boolean => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        // Gone between the open and the read: the next attempt takes it.
      }
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder))
        return false;
      rmSync(path, { force: true }); // stale: a previous life's
    }
  }
  return false;
};

const reply = (socket: Socket, result: Reply) => {
  socket.end(`${JSON.stringify(result)}\n`);
};

/** The production entrypoint: wire the real driver and run until stopped. */
export const main = async (): Promise<void> => {
  Object.assign(process.env, withLoopbackUnproxied(process.env));
  const homeDir = agentHomeDir(process.env);
  mkdirSync(browserStateDir(homeDir), { recursive: true, mode: 0o700 });
  mkdirSync(browserOutputDir(homeDir), { recursive: true });
  const driver = new Driver({
    environment: environmentFromEnv(process.env),
    outputDir: browserOutputDir(homeDir),
  });
  const daemon = await startDaemon({
    socketPath: browserSocketPath(homeDir),
    holdPath: browserHoldPath(homeDir),
    handle: (request) => driver.handle(request),
    shutdown: async () => {
      await driver.close();
      process.exit(0);
    },
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void daemon.close());
  }
};
