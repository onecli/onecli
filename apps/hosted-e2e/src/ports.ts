import { createServer } from "node:net";

/**
 * Ports for the listeners a scenario binds itself and may have to bind AGAIN
 * (the runner's control channel: a restart reuses its predecessor's port).
 *
 * They come from a fixed range below the OS's ephemeral range (Linux hands
 * out 32768-60999 for outgoing connections and for `listen(0)`, macOS
 * 49152-65535). A port the OS picked from the ephemeral range is free only
 * until the next outgoing connection or `listen(0)`, anywhere on the host,
 * takes it: CI saw a restarted runner fail with EADDRINUSE on its own old
 * port that way. Nothing on the host is handed a port from this range
 * unless it asks for that number.
 *
 * Each vitest fork walks its own slice of the range (VITEST_POOL_ID), so the
 * two forks never hand out the same port. A port is checked by binding it
 * before it is returned, and a port already handed out in this process is
 * never handed out again, so a port released by one scenario's runner is not
 * given to the next one while it may still be in use.
 */
const RANGE_START = 20_000;
const RANGE_END = 32_767;
/** One slice per fork; the config runs two (`maxForks: 2`). */
const SLICES = 4;

const slice = (): { start: number; end: number } => {
  // Set by vitest inside each fork (1-based), never by the caller's shell:
  // not a Turbo task input.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const pool = Number(process.env.VITEST_POOL_ID ?? "1");
  const index = Number.isInteger(pool) && pool > 0 ? (pool - 1) % SLICES : 0;
  const size = Math.floor((RANGE_END - RANGE_START + 1) / SLICES);
  const start = RANGE_START + index * size;
  return { start, end: start + size - 1 };
};

const handedOut = new Set<number>();
let cursor: number | undefined;

/** Whether nothing on the host is bound to `port`, checked by binding it on
 * every interface, the way the runner's control channel binds. */
const canBind = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });

/**
 * A port nothing holds right now, from this fork's slice. Every consumer
 * still fails loudly on EADDRINUSE, so a collision with something outside
 * this suite reads as a failure, never a silent misdirection.
 */
export const freePort = async (): Promise<number> => {
  const { start, end } = slice();
  for (let tried = 0; tried <= end - start; tried += 1) {
    const port: number =
      cursor === undefined || cursor >= end ? start : cursor + 1;
    cursor = port;
    if (handedOut.has(port)) continue;
    if (await canBind(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error(`no free port left in ${start}-${end}`);
};

/**
 * A free port that is NOT `excluded`: for a replacement process that must
 * sit somewhere other than the address its predecessor used. `freePort`
 * never repeats a port it handed out, so this only guards a port the caller
 * got some other way.
 */
export const freePortOtherThan = async (excluded: number): Promise<number> => {
  for (;;) {
    const port = await freePort();
    if (port !== excluded) return port;
  }
};
