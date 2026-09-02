import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

/**
 * `uninstallRemotePresence` is best-effort BY CONTRACT: it runs ahead of the
 * app-record delete during teardown, and teardown must never fail because a
 * stored credential is unusable. A throw here surfaces to the user as a failed
 * deletion.
 *
 * The pg-proof suite covers the happy path and the refusal arm through a Slack
 * fake. These are the arms that never reach Slack at all — the ones a fake
 * cannot exercise, because they fail before any request is made. A live probe
 * caught exactly one of them for real: a malformed credential row threw a
 * SyntaxError out of the parse, which the surrounding `.catch()` on the
 * network call could not see.
 */
const uninstall = async (credentialsJson: string | null) => {
  const { slackProvider } = await import("./provider");
  await slackProvider.uninstallRemotePresence?.({ credentialsJson });
};

describe("uninstallRemotePresence answers rather than throws", () => {
  it("on a null credential (a presence we never stored one for)", async () => {
    await expect(uninstall(null)).resolves.toBeUndefined();
  });

  it("on a MALFORMED credential row — the parse must not escape", async () => {
    // Regression: this threw `SyntaxError: Expected property name` before the
    // parse moved inside the try, which teardown would have reported as a
    // failed delete for a row that is merely unreadable.
    await expect(uninstall("{not json")).resolves.toBeUndefined();
  });

  it("on a credential whose JSON is valid but not an object", async () => {
    await expect(uninstall('"a string"')).resolves.toBeUndefined();
  });

  it("on the paste floor (a bot token, but no client id or secret)", async () => {
    // Nothing to uninstall WITH: the user made the app, so we never saw its
    // secret. Skipped silently, and the manifest delete still runs.
    await expect(
      uninstall(JSON.stringify({ botToken: "xoxb-d" })),
    ).resolves.toBeUndefined();
  });

  it("on client credentials with no bot token", async () => {
    await expect(
      uninstall(JSON.stringify({ clientId: "c", clientSecret: "s" })),
    ).resolves.toBeUndefined();
  });
});

/**
 * The rename's OWN unreadable-credential arm. It runs AFTER the manifest has
 * already been updated, so a throw there would reach the caller as "could not
 * rename; it keeps its old name" — the opposite of what happened, and a delete
 * decision made on a false premise. Answering `false` states the truth: the
 * rename cannot be CONFIRMED, so the app is left alive.
 *
 * Needs a Slack that says yes to the export/update, which is why it stands up
 * a fake rather than pointing at a dead port like the arms above.
 */
describe("renameRemotePresence answers false when it cannot CONFIRM", () => {
  let server: Server;
  let updated = false;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createServer((req, res) => {
          req.resume();
          req.on("end", () => {
            const method = (req.url ?? "/").slice(1);
            if (method === "apps.manifest.update") updated = true;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify(
                method === "apps.manifest.export"
                  ? { ok: true, manifest: { display_information: {} } }
                  : { ok: true },
              ),
            );
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          process.env.SLACK_API_BASE_URL = `http://127.0.0.1:${port}`;
          resolve();
        });
      }),
  );

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("on a malformed credential row — after the rename already landed", async () => {
    const { slackProvider } = await import("./provider");

    const confirmed = await slackProvider.renameRemotePresence?.({
      accessToken: "xoxe.xoxp-t",
      externalId: "A1",
      credentialsJson: "{not json",
      identityRef: "U1",
    });

    // The rename DID happen — the parse throwing after it must not be
    // reported as a failure to rename.
    expect(updated).toBe(true);
    expect(confirmed).toBe(false);
  });
});
