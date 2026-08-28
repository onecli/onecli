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

const { migrateNanoclawRoutes } = await import("./migrate-nanoclaw");

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
