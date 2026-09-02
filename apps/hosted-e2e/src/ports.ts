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
