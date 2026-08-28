import { describe, expect, it } from "vitest";
import { formatEd25519PublicKeyLine } from "@onecli/ssh-cert";
import { ConfigError } from "./errors";
import { loadTerminatorConfig, type TerminatorBackendConfig } from "./config";
import { createTestCa } from "./test-fixtures";

const CA_LINE = formatEd25519PublicKeyLine(createTestCa().publicKey);

const baseEnv = (): NodeJS.ProcessEnv => ({
  TERMINATOR_HOST_KEY: "fake-host-key",
  TERMINATOR_CA_PUBLIC_KEY: CA_LINE,
  TERMINATOR_CONTROL_PLANE_URL: "http://control-plane.test",
  TERMINATOR_CONTROL_PLANE_TOKEN: "cp-secret",
  TERMINATOR_MANAGER_URL: "http://manager.test:8090",
  TERMINATOR_BROKER_TOKEN: "broker-secret",
});

/** The docker-arm base: same core, no kube signal anywhere. */
const dockerEnv = (): NodeJS.ProcessEnv => {
  const env = baseEnv();
  delete env.TERMINATOR_MANAGER_URL;
  delete env.TERMINATOR_BROKER_TOKEN;
  return env;
};

const kubeArm = (
  backend: TerminatorBackendConfig,
): Extract<TerminatorBackendConfig, { kind: "kube" }> => {
  if (backend.kind !== "kube") throw new Error("expected the kube arm");
  return backend;
};

const dockerArm = (
  backend: TerminatorBackendConfig,
): Extract<TerminatorBackendConfig, { kind: "docker" }> => {
  if (backend.kind !== "docker") throw new Error("expected the docker arm");
  return backend;
};

describe("loadTerminatorConfig", () => {
  it("loads with defaults (kube arm inferred from the manager URL)", () => {
    const config = loadTerminatorConfig(baseEnv());
    expect(config.port).toBe(2222);
    expect(config.healthPort).toBe(8091);
    expect(config.wakeWaitSeconds).toBe(180);
    expect(config.maxSessions).toBe(256);
    expect(config.maxSessionsPerIp).toBe(8);
    expect(config.preauthPerIpPerMinute).toBe(12);
    expect(config.preauthTimeoutSeconds).toBe(30);
    expect(config.caPublicKey).toHaveLength(32);
    const kube = kubeArm(config.backend);
    expect(kube.kubeCaFile).toBe("/var/run/onecli/kube-root-ca/ca.crt");
    expect(kube.kubeServer).toBeNull();
  });

  it("derives the API server address from the injected kubelet env", () => {
    const config = loadTerminatorConfig({
      ...baseEnv(),
      KUBERNETES_SERVICE_HOST: "10.100.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    });
    expect(kubeArm(config.backend).kubeServer).toBe("https://10.100.0.1:443");
  });

  it("brackets an IPv6 API server host", () => {
    const config = loadTerminatorConfig({
      ...baseEnv(),
      KUBERNETES_SERVICE_HOST: "fd00::1",
      KUBERNETES_SERVICE_PORT: "443",
    });
    expect(kubeArm(config.backend).kubeServer).toBe("https://[fd00::1]:443");
  });

  it.each([
    ["TERMINATOR_HOST_KEY", "host key"],
    ["TERMINATOR_CA_PUBLIC_KEY", "trust anchor"],
    ["TERMINATOR_CONTROL_PLANE_URL", "control plane"],
    ["TERMINATOR_CONTROL_PLANE_TOKEN", "control plane secret"],
    ["TERMINATOR_BROKER_TOKEN", "broker secret"],
  ])("refuses to boot without %s", (key) => {
    const env = baseEnv();
    delete env[key];
    expect(() => loadTerminatorConfig(env)).toThrow(ConfigError);
  });

  it("accepts secret ARNs in place of direct secrets", () => {
    const env = baseEnv();
    delete env.TERMINATOR_HOST_KEY;
    delete env.TERMINATOR_CONTROL_PLANE_TOKEN;
    delete env.TERMINATOR_BROKER_TOKEN;
    env.TERMINATOR_HOST_KEY_SECRET_ARN = "arn:aws:secretsmanager:x:1:secret:hk";
    env.TERMINATOR_CONTROL_PLANE_SECRET_ARN =
      "arn:aws:secretsmanager:x:1:secret:cp";
    env.TERMINATOR_BROKER_SECRET_ARN = "arn:aws:secretsmanager:x:1:secret:bk";
    env.SANDBOX_METRIC_NAMESPACE = "OneCLI/SandboxPlatform/dev";
    const config = loadTerminatorConfig(env);
    expect(config.hostKeySecretArn).toContain("secret:hk");
    expect(config.controlPlaneSecretArn).toContain("secret:cp");
    expect(kubeArm(config.backend).brokerSecretArn).toContain("secret:bk");
    expect(config.metricNamespace).toBe("OneCLI/SandboxPlatform/dev");
  });

  it("refuses cloud mode (host key via ARN) without a metric namespace — a base-namespace fallback would publish into a namespace-conditioned AccessDenied", () => {
    const env = baseEnv();
    delete env.TERMINATOR_HOST_KEY;
    env.TERMINATOR_HOST_KEY_SECRET_ARN = "arn:aws:secretsmanager:x:1:secret:hk";
    expect(() => loadTerminatorConfig(env)).toThrow(/SANDBOX_METRIC_NAMESPACE/);
  });

  it("falls back to the base namespace in local/token mode only", () => {
    expect(loadTerminatorConfig(baseEnv()).metricNamespace).toBe(
      "OneCLI/SandboxPlatform",
    );
  });

  it("refuses a non-ed25519 CA line", () => {
    const env = baseEnv();
    env.TERMINATOR_CA_PUBLIC_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB";
    expect(() => loadTerminatorConfig(env)).toThrow(ConfigError);
  });

  it("refuses a garbage CA line", () => {
    const env = baseEnv();
    env.TERMINATOR_CA_PUBLIC_KEY = "not-a-key";
    expect(() => loadTerminatorConfig(env)).toThrow(ConfigError);
  });

  it("throws on a SET but unparsable integer, never a silent default", () => {
    expect(() =>
      loadTerminatorConfig({ ...baseEnv(), TERMINATOR_PORT: "222x" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadTerminatorConfig({ ...baseEnv(), TERMINATOR_MAX_SESSIONS: "0" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadTerminatorConfig({
        ...baseEnv(),
        TERMINATOR_WAKE_WAIT_SECONDS: "-5",
      }),
    ).toThrow(ConfigError);
  });

  it("applies explicit overrides", () => {
    const config = loadTerminatorConfig({
      ...baseEnv(),
      TERMINATOR_PORT: "2022",
      TERMINATOR_MAX_SESSIONS_PER_IP: "3",
      TERMINATOR_KUBE_CA_FILE: "/tmp/ca.crt",
    });
    expect(config.port).toBe(2022);
    expect(config.maxSessionsPerIp).toBe(3);
    expect(kubeArm(config.backend).kubeCaFile).toBe("/tmp/ca.crt");
  });
});

describe("loadTerminatorConfig — substrate selection", () => {
  it("selects the docker arm with a default socket when no kube signal exists", () => {
    const config = loadTerminatorConfig(dockerEnv());
    expect(dockerArm(config.backend).socketPath).toBe("/var/run/docker.sock");
  });

  it("honors TERMINATOR_DOCKER_SOCKET", () => {
    const config = loadTerminatorConfig({
      ...dockerEnv(),
      TERMINATOR_DOCKER_SOCKET: "/tmp/docker.sock",
    });
    expect(dockerArm(config.backend).socketPath).toBe("/tmp/docker.sock");
  });

  it("an explicit TERMINATOR_BACKEND=kube without a manager URL fails loud (message-identical)", () => {
    expect(() =>
      loadTerminatorConfig({ ...dockerEnv(), TERMINATOR_BACKEND: "kube" }),
    ).toThrow(/TERMINATOR_MANAGER_URL is required/);
  });

  it("an explicit TERMINATOR_BACKEND=docker wins over kube signals", () => {
    const config = loadTerminatorConfig({
      ...baseEnv(),
      TERMINATOR_BACKEND: "docker",
    });
    expect(config.backend.kind).toBe("docker");
  });

  // The anti-misfence guard: a cloud pod that loses its manager URL must
  // still select kube and refuse loud — never silently boot a docker arm
  // with no socket (this loader's founding law).
  it("a kubelet-injected env selects kube and fails loud without the manager URL", () => {
    expect(() =>
      loadTerminatorConfig({
        ...dockerEnv(),
        KUBERNETES_SERVICE_HOST: "10.100.0.1",
        KUBERNETES_SERVICE_PORT: "443",
      }),
    ).toThrow(/TERMINATOR_MANAGER_URL is required/);
  });

  it("a Secrets-Manager host key selects kube and fails loud without the manager URL", () => {
    const env = dockerEnv();
    delete env.TERMINATOR_HOST_KEY;
    env.TERMINATOR_HOST_KEY_SECRET_ARN = "arn:aws:secretsmanager:x:1:secret:hk";
    env.SANDBOX_METRIC_NAMESPACE = "OneCLI/SandboxPlatform/dev";
    expect(() => loadTerminatorConfig(env)).toThrow(
      /TERMINATOR_MANAGER_URL is required/,
    );
  });

  it("refuses an unknown TERMINATOR_BACKEND value", () => {
    expect(() =>
      loadTerminatorConfig({ ...dockerEnv(), TERMINATOR_BACKEND: "podman" }),
    ).toThrow(/TERMINATOR_BACKEND/);
  });
});
