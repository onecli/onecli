import { describe, expect, it } from "vitest";
import { buildKubeGuestCommand } from "./exec-backend";

describe("buildKubeGuestCommand", () => {
  // The full argv is byte-pinned: this is the pre-split buildGuestCommand
  // output verbatim — the kube substrate's identity drop around the shared
  // payload must never drift (the guest contract is proven live).
  it("wraps a shell in the identity drop, landing in /workspace", () => {
    expect(buildKubeGuestCommand({ kind: "shell" })).toEqual([
      "env",
      "HOME=/workspace/.home",
      "USER=node",
      "LOGNAME=node",
      "setpriv",
      "--reuid",
      "node",
      "--regid",
      "node",
      "--init-groups",
      "--",
      "sh",
      "-c",
      "mkdir -p /workspace/.home 2>/dev/null || true; cd /workspace 2>/dev/null || cd /home/node; exec bash -l",
    ]);
  });

  it("never uses --reset-env (it would strip the gateway proxy env)", () => {
    for (const request of [
      { kind: "shell" } as const,
      { kind: "exec", command: "ls" } as const,
      { kind: "sftp" } as const,
    ]) {
      expect(buildKubeGuestCommand(request)).not.toContain("--reset-env");
    }
  });

  it("carries the shared payload as the sh -c script on every kind", () => {
    for (const request of [
      { kind: "exec", command: "echo hi" } as const,
      { kind: "sftp" } as const,
    ]) {
      const command = buildKubeGuestCommand(request);
      expect(command.at(-2)).toBe("-c");
      expect(command.at(-1)).toContain("mkdir -p /workspace/.home");
    }
  });
});
