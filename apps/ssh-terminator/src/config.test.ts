import { describe, expect, it } from "vitest";
import { formatEd25519PublicKeyLine } from "@onecli/ssh-cert";
import { ConfigError } from "./errors";
import { loadTerminatorConfig } from "./config";
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

describe("loadTerminatorConfig", () => {
  it("loads with defaults", () => {
    const config = loadTerminatorConfig(baseEnv());
    expect(config.port).toBe(2222);
    expect(config.healthPort).toBe(8091);
    expect(config.wakeWaitSeconds).toBe(180);
    expect(config.maxSessions).toBe(256);
    expect(config.maxSessionsPerIp).toBe(8);
    expect(config.preauthPerIpPerMinute).toBe(12);
    expect(config.preauthTimeoutSeconds).toBe(30);
    expect(config.kubeCaFile).toBe("/var/run/onecli/kube-root-ca/ca.crt");
    expect(config.caPublicKey).toHaveLength(32);
    expect(config.kubeServer).toBeNull();
  });

  it("derives the API server address from the injected kubelet env", () => {
    const config = loadTerminatorConfig({
      ...baseEnv(),
      KUBERNETES_SERVICE_HOST: "10.100.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    });
    expect(config.kubeServer).toBe("https://10.100.0.1:443");
  });

  it("brackets an IPv6 API server host", () => {
    const config = loadTerminatorConfig({
      ...baseEnv(),
      KUBERNETES_SERVICE_HOST: "fd00::1",
      KUBERNETES_SERVICE_PORT: "443",
    });
    expect(config.kubeServer).toBe("https://[fd00::1]:443");
  });

  it.each([
    ["TERMINATOR_HOST_KEY", "host key"],
    ["TERMINATOR_CA_PUBLIC_KEY", "trust anchor"],
    ["TERMINATOR_CONTROL_PLANE_URL", "control plane"],
    ["TERMINATOR_CONTROL_PLANE_TOKEN", "control plane secret"],
    ["TERMINATOR_MANAGER_URL", "manager"],
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
    expect(config.brokerSecretArn).toContain("secret:bk");
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
    expect(config.kubeCaFile).toBe("/tmp/ca.crt");
  });
});
