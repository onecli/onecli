import { describe, expect, it } from "vitest";
import { buildGuestCommand } from "./relay";

describe("buildGuestCommand", () => {
  it("wraps a shell in the identity drop, landing in /workspace", () => {
    expect(buildGuestCommand({ kind: "shell" })).toEqual([
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

  it("heals a missing durable home on every request kind, soft-failing", () => {
    // A RUNNING pre-change sandbox predates the entrypoint that creates
    // /workspace/.home; the relay's mkdir token heals it per-session. It
    // must be present on every kind AND `|| true`-terminated — a hard
    // failure here would kill the session over a cosmetic dir.
    for (const request of [
      { kind: "shell" } as const,
      { kind: "exec", command: "ls" } as const,
      { kind: "sftp" } as const,
    ]) {
      const script = buildGuestCommand(request).at(-1);
      expect(script).toContain(
        "mkdir -p /workspace/.home 2>/dev/null || true; ",
      );
    }
  });

  it("never uses --reset-env (it would strip the gateway proxy env)", () => {
    for (const request of [
      { kind: "shell" } as const,
      { kind: "exec", command: "ls" } as const,
      { kind: "sftp" } as const,
    ]) {
      expect(buildGuestCommand(request)).not.toContain("--reset-env");
    }
  });

  it("runs exec commands through a login shell (OpenSSH semantics)", () => {
    const command = buildGuestCommand({ kind: "exec", command: "echo hi" });
    expect(command[command.length - 1]).toBe(
      "mkdir -p /workspace/.home 2>/dev/null || true; cd /workspace 2>/dev/null || cd /home/node; exec sh -lc 'echo hi'",
    );
  });

  it("single-quote-escapes hostile exec commands", () => {
    const command = buildGuestCommand({
      kind: "exec",
      command: `echo 'a'; rm -rf "$HOME"`,
    });
    expect(command[command.length - 1]).toBe(
      `mkdir -p /workspace/.home 2>/dev/null || true; ` +
        `cd /workspace 2>/dev/null || cd /home/node; ` +
        `exec sh -lc 'echo '\\''a'\\''; rm -rf "$HOME"'`,
    );
  });

  it("routes the sftp subsystem to the in-guest sftp-server", () => {
    const command = buildGuestCommand({ kind: "sftp" });
    expect(command[command.length - 1]).toBe(
      "mkdir -p /workspace/.home 2>/dev/null || true; cd /workspace 2>/dev/null || cd /home/node; exec /usr/lib/openssh/sftp-server",
    );
  });
});
