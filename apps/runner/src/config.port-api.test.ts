import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

/**
 * The port API is the preview relay's door into sandbox ports. Its bind
 * address is a security posture: on a Docker host every sandbox can reach
 * the host's interfaces, so listening beyond loopback must be asked for.
 */
const base = {
  RUNNER_TOKEN: "rnr_test_token_for_config",
} as NodeJS.ProcessEnv;
const token = "t".repeat(32);

describe("runner port API config", () => {
  it("is off unless both port and token are set", () => {
    expect(loadConfig({ ...base }).portApi).toBeNull();
  });

  it("binds loopback by default, never every interface", () => {
    const cfg = loadConfig({
      ...base,
      RUNNER_PORT_API_PORT: "8485",
      RUNNER_PORT_API_TOKEN: token,
    });
    expect(cfg.portApi).toEqual({
      port: 8485,
      token,
      host: "127.0.0.1",
      advertisedUrl: "http://127.0.0.1:8485",
    });
  });

  it("binds a wider address only when the deployment says so", () => {
    const cfg = loadConfig({
      ...base,
      RUNNER_PORT_API_PORT: "8485",
      RUNNER_PORT_API_TOKEN: token,
      RUNNER_PORT_API_HOST: "0.0.0.0",
      RUNNER_PORT_API_ADVERTISED_HOST: "10.0.0.9",
    });
    expect(cfg.portApi?.host).toBe("0.0.0.0");
  });

  it("refuses a short token", () => {
    expect(() =>
      loadConfig({
        ...base,
        RUNNER_PORT_API_PORT: "8485",
        RUNNER_PORT_API_TOKEN: "short",
      }),
    ).toThrow(ConfigError);
  });

  describe("the address this copy announces (the relay dials the copy holding a sandbox)", () => {
    it("a loopback bind announces itself", () => {
      const cfg = loadConfig({
        ...base,
        RUNNER_PORT_API_PORT: "8485",
        RUNNER_PORT_API_TOKEN: token,
      });
      expect(cfg.portApi?.advertisedUrl).toBe("http://127.0.0.1:8485");
    });

    it("a wide bind announces the advertised host (the pod's own address)", () => {
      const cfg = loadConfig({
        ...base,
        RUNNER_PORT_API_PORT: "8485",
        RUNNER_PORT_API_TOKEN: token,
        RUNNER_PORT_API_HOST: "0.0.0.0",
        RUNNER_PORT_API_ADVERTISED_HOST: "10.0.4.17",
      });
      expect(cfg.portApi?.advertisedUrl).toBe("http://10.0.4.17:8485");
    });

    it("refuses a wide bind with nothing to announce: no relay could reach it", () => {
      for (const host of ["0.0.0.0", "::"]) {
        expect(() =>
          loadConfig({
            ...base,
            RUNNER_PORT_API_PORT: "8485",
            RUNNER_PORT_API_TOKEN: token,
            RUNNER_PORT_API_HOST: host,
          }),
        ).toThrow(ConfigError);
      }
    });

    it("refuses an advertised host that is not a bare host (it becomes a URL)", () => {
      for (const bad of ["10.0.0.1:80", "http://x", "a/b", "user@h"]) {
        expect(() =>
          loadConfig({
            ...base,
            RUNNER_PORT_API_PORT: "8485",
            RUNNER_PORT_API_TOKEN: token,
            RUNNER_PORT_API_HOST: "0.0.0.0",
            RUNNER_PORT_API_ADVERTISED_HOST: bad,
          }),
        ).toThrow(ConfigError);
      }
    });
  });
});

describe("runner copy identity", () => {
  it("names the copy by its hostname unless told otherwise", async () => {
    const { hostname } = await import("node:os");
    expect(loadConfig({ ...base }).replicaName).toBe(hostname());
    expect(
      loadConfig({ ...base, RUNNER_REPLICA_NAME: "pod-a" }).replicaName,
    ).toBe("pod-a");
  });

  it("sandboxes dial the advertised port, which defaults to the listen port", () => {
    expect(loadConfig({ ...base, RUNNER_WS_PORT: "9000" }).advertisedPort).toBe(
      9000,
    );
    // Behind a balancer whose front port differs from the copies' own.
    expect(
      loadConfig({
        ...base,
        RUNNER_WS_PORT: "9001",
        RUNNER_ADVERTISED_PORT: "8484",
      }).advertisedPort,
    ).toBe(8484);
  });
});
