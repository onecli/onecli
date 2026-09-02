import { createServer, type Server as HttpServer } from "node:http";

/**
 * The health listener the NLB target group probes (HTTP :8091). Deliberately
 * dumb — a bare 200/503 with zero operational detail: this port is reachable
 * from the VPC and reveals nothing about sessions, versions or config.
 */

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

export const startHealthServer = (options: {
  port: number;
  isReady: () => boolean;
}): Promise<HealthServer> => {
  const server: HttpServer = createServer((_request, response) => {
    const ready = options.isReady();
    response.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
    response.end(ready ? "ok" : "starting");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      const address = server.address();
      const port =
        address !== null && typeof address === "object"
          ? address.port
          : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
};
