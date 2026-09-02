import { describe, expect, it } from "vitest";
import { buildGuestPayload } from "./relay";

describe("buildGuestPayload", () => {
  it("lands a shell in the durable home", () => {
    expect(buildGuestPayload({ kind: "shell" })).toBe(
      "mkdir -p /workspace/.home 2>/dev/null || true; cd /workspace 2>/dev/null || cd /home/node; exec bash -l",
    );
  });

  it("heals a missing durable home on every request kind, soft-failing", () => {
    // A RUNNING pre-change sandbox predates the entrypoint that creates
    // /workspace/.home; the payload's mkdir token heals it per-session. It
    // must be present on every kind AND `|| true`-terminated — a hard
    // failure here would kill the session over a cosmetic dir.
    for (const request of [
      { kind: "shell" } as const,
      { kind: "exec", command: "ls" } as const,
      { kind: "sftp" } as const,
    ]) {
      expect(buildGuestPayload(request)).toContain(
        "mkdir -p /workspace/.home 2>/dev/null || true; ",
      );
    }
  });

  it("runs exec commands through a login shell (OpenSSH semantics)", () => {
    expect(buildGuestPayload({ kind: "exec", command: "echo hi" })).toBe(
      "mkdir -p /workspace/.home 2>/dev/null || true; cd /workspace 2>/dev/null || cd /home/node; exec sh -lc 'echo hi'",
    );
  });

  it("single-quote-escapes hostile exec commands", () => {
    expect(
      buildGuestPayload({
        kind: "exec",
        command: `echo 'a'; rm -rf "$HOME"`,
      }),
    ).toBe(
      `mkdir -p /workspace/.home 2>/dev/null || true; ` +
        `cd /workspace 2>/dev/null || cd /home/node; ` +
        `exec sh -lc 'echo '\\''a'\\''; rm -rf "$HOME"'`,
    );
  });

  it("routes the sftp subsystem to the in-guest sftp-server", () => {
    expect(buildGuestPayload({ kind: "sftp" })).toBe(
      "mkdir -p /workspace/.home 2>/dev/null || true; cd /workspace 2>/dev/null || cd /home/node; exec /usr/lib/openssh/sftp-server",
    );
  });
});
