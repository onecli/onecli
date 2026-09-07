import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

// The NanoClaw migration script's .env format is a FROZEN field contract:
// deployed NanoClaw installs carry `ONECLI_URL=` / `ONECLI_API_KEY=` lines
// this script wrote, and re-running it must keep grep-v-ing and re-appending
// those exact keys forever. The ONECLI_URL *name* is banned for new surfaces
// (it collided with the dashboard-URL meaning); this route is the sole
// deliberate survivor. These pins exist so a rename sweep cannot touch it.

vi.mock("../providers", () => ({
  getSelfUrl: () => "https://api.test.example",
}));

const { migrateNanoclawRoutes, SECRET_EXTRACTOR_JS } =
  await import("./migrate-nanoclaw");

const app = migrateNanoclawRoutes();
const run = promisify(execFile);

const fetchScript = async () => {
  // No `key=`: the keyless path builds the same frozen script (device-auth
  // block instead of a pinned key) without touching the database.
  const res = await app.request("/nanoclaw?url=https://api.test.example");
  expect(res.status).toBe(200);
  return res.text();
};

describe("migrate-nanoclaw — frozen .env contract", () => {
  it("keeps the ONECLI_URL script var and DASHBOARD_URL beside it", async () => {
    const script = await fetchScript();
    expect(script).toContain('ONECLI_URL="https://api.test.example"');
    expect(script).toContain('DASHBOARD_URL="http://localhost:10254"');
  });

  it("keeps the exact grep-v strip of both frozen keys", async () => {
    const script = await fetchScript();
    expect(script).toContain(
      'grep -v "^ONECLI_URL=" "$ENV_FILE" | grep -v "^ONECLI_API_KEY=" > "$ENV_FILE.tmp"',
    );
  });

  it("keeps the exact re-append of both frozen keys", async () => {
    const script = await fetchScript();
    expect(script).toContain('echo "ONECLI_URL=$ONECLI_URL" >> "$ENV_FILE"');
    expect(script).toContain(
      'echo "ONECLI_API_KEY=$ONECLI_API_KEY" >> "$ENV_FILE"',
    );
  });

  it("keeps the manual-fallback instructions naming the frozen keys", async () => {
    const script = await fetchScript();
    expect(script).toContain('echo "    ONECLI_URL=$ONECLI_URL"');
    expect(script).toContain('echo "    ONECLI_API_KEY=$ONECLI_API_KEY"');
  });

  it("is valid shell (sh -n)", async () => {
    const script = await fetchScript();
    const dir = mkdtempSync(join(tmpdir(), "onecli-nanoclaw-"));
    const file = join(dir, "migrate.sh");
    writeFileSync(file, script);
    await expect(run("sh", ["-n", file])).resolves.toBeTruthy();
  });
});

describe("migrate-nanoclaw — the secret data step", () => {
  it("runs the data step BEFORE any config is touched", async () => {
    // The safety property: a failed migration must leave the user fully on v1.
    // The extractor heredoc, its abort (`exit 1`), and the no-container skip
    // all sit before the first mutation (the config.json rewrite).
    const script = await fetchScript();
    const dataStep = script.indexOf("Migrate local secrets to cloud");
    const abort = script.indexOf("Secret migration failed");
    const firstMutation = script.indexOf('printf \'{\n  "api-host"');
    expect(dataStep).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(dataStep);
    expect(firstMutation).toBeGreaterThan(abort);
  });

  it("aborts the script when migration fails, and only then", async () => {
    const script = await fetchScript();
    // The failure arm exits; the no-container arm merely skips.
    expect(script).toContain("nothing has been changed");
    expect(script).toContain("exit 1");
    expect(script).toContain("skipping secret migration");
  });

  it("no longer pulls or restarts the local OneCLI Docker install", async () => {
    // The old step upgraded the v1 install mid-migration — pointless risk now
    // that the extractor reads the database directly. (The closing "to stop
    // it" hint still mentions compose — informational, not an action.)
    const script = await fetchScript();
    expect(script).not.toContain("pull");
    expect(script).not.toContain("up -d --wait");
    expect(script).not.toContain("Updating local OneCLI Docker image");
  });

  it("passes credentials via docker exec -e, never into the heredoc", async () => {
    const script = await fetchScript();
    expect(script).toContain(
      '-e MIGRATE_CLOUD_URL="$MIGRATE_URL" -e MIGRATE_CLOUD_KEY="$ONECLI_API_KEY"',
    );
    // Quoted delimiter: the shell must not expand anything inside the JS.
    expect(script).toContain("<<'ONECLI_MIGRATE_EOF'");
  });

  it("embeds syntactically valid Node (node --check)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onecli-extractor-"));
    const file = join(dir, "extractor.cjs");
    writeFileSync(file, SECRET_EXTRACTOR_JS);
    await expect(run("node", ["--check", file])).resolves.toBeTruthy();
  });

  it("never prints a secret value", () => {
    // Every output line in the extractor carries names/counts only. Pin the
    // one variable that ever holds plaintext out of all console calls.
    const consoleLines = SECRET_EXTRACTOR_JS.split("\n").filter((l) =>
      l.includes("console."),
    );
    for (const line of consoleLines) {
      expect(line).not.toContain("value");
      expect(line).not.toContain("encryptedValue");
    }
  });

  it("omits null fields from the import body (cloud rejects explicit null)", () => {
    expect(SECRET_EXTRACTOR_JS).toContain(
      "if (r.pathPattern) body.pathPattern",
    );
    expect(SECRET_EXTRACTOR_JS).toContain(
      "if (r.injectionConfig) body.injectionConfig",
    );
  });

  it("pre-checks existing names — the idempotency guard", () => {
    // POST /v1/secrets answers 201 for duplicate names; only this pre-check
    // makes re-running the script safe.
    expect(SECRET_EXTRACTOR_JS).toContain(
      'fetch(CLOUD_URL + "/v1/secrets", { headers })',
    );
    expect(SECRET_EXTRACTOR_JS).toContain("have.has(r.name)");
  });
});
