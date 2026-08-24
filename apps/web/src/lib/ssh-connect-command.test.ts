import { describe, expect, it } from "vitest";
import { buildSshConnectCommand } from "./ssh-connect-command";

const MINTED = {
  certificate: "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC8x+Base64/Blob=",
  user: "2f4d0375-01f1-4d9d-9a9d-80538785a71c",
  // RFC-2606-style placeholder — a real deployment hostname must never sit
  // in a synced file (CLOUD-DEVELOPMENT.md golden rule).
  host: "ssh.onecli.test",
};

describe("buildSshConnectCommand", () => {
  it("writes the cert beside the default key, then connects", () => {
    expect(buildSshConnectCommand(MINTED)).toBe(
      "printf '%s\\n' 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC8x+Base64/Blob=' " +
        "> ~/.ssh/id_ed25519-cert.pub && " +
        "ssh 2f4d0375-01f1-4d9d-9a9d-80538785a71c@ssh.onecli.test",
    );
  });

  it("keeps the printf newline LITERAL (\\n reaches the shell, not a real newline)", () => {
    const command = buildSshConnectCommand(MINTED);
    expect(command).toContain("printf '%s\\n'");
    expect(command).not.toContain("\n");
  });

  it("is injection-proof: a quote in the certificate cannot escape the argument", () => {
    // Impossible by the cert line's charset, pinned anyway: the command must
    // be safe by construction, not by the current shape of its inputs.
    const command = buildSshConnectCommand({
      ...MINTED,
      certificate: "evil' ; rm -rf ~ ; '",
    });
    expect(command).toContain("'evil'\\'' ; rm -rf ~ ; '\\'''");
  });
});
