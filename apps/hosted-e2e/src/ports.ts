import { createServer } from "node:net";

/**
 * A free TCP port, from the OS. Bind 0, read the assignment, close. There is
 * an inherent race between close and the caller's own bind — tolerated: the
 * window is milliseconds, two forks make collisions rare, and every consumer
 * fails loudly on EADDRINUSE so a collision reads as a retryable failure,
 * never a silent misdirection.
 */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

/**
 * A free port that is NOT `excluded`: for a replacement process that must
 * sit somewhere other than the address its predecessor used. Asking the OS
 * (rather than pinning a neighbour such as `excluded + 1`) matters: a
 * neighbour is not free just because the predecessor's port was, and
 * anything on the host can be holding it (the other fork's servers, an
 * outbound connection's local port). The OS can hand back the port the
 * predecessor just released, so that one answer is refused and asked again.
 */
export const freePortOtherThan = async (excluded: number): Promise<number> => {
  for (;;) {
    const port = await freePort();
    if (port !== excluded) return port;
  }
};
