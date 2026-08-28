import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareMcpConfig, resolveMcpBridgePath } from "./jcode";

/**
 * The managed MCP config (step 7). Two laws pinned here:
 * 1. What we write is exactly what jcode's serde expects — `mcpServers`,
 *    stdio command, `shared:false` — because a drifted key is silently
 *    dropped at config load, which presents as "the tools don't exist".
 * 2. The agent-writable override slots are DELETED per boot: project-local
 *    files (jcode's vendor sense of "project") merge LAST in jcode and would
 *    shadow the managed server by name.
 */

const makeHome = () => mkdtempSync(join(tmpdir(), "jcode-mcp-"));

const homeOf = (dir: string): string => {
  const home = join(dir, ".jcode-home");
  mkdirSync(home, { recursive: true });
  return home;
};

describe("the managed mcp.json", () => {
  it("writes the serde-exact shape: mcpServers, absolute node command, shared:false, the socket env", () => {
    const dir = makeHome();
    const home = homeOf(dir);

    prepareMcpConfig(dir, home, "/tmp/test-tools.sock");

    const raw = readFileSync(join(home, "mcp.json"), "utf8");
    const config = JSON.parse(raw) as {
      mcpServers: Record<
        string,
        {
          command: string;
          args: string[];
          env: Record<string, string>;
          shared: boolean;
        }
      >;
    };
    const server = config.mcpServers.onecli;
    expect(server).toBeDefined();
    // process.execPath: no PATH lookup, nothing the agent's env can redirect.
    expect(server!.command).toBe(process.execPath);
    expect(server!.args).toHaveLength(1);
    expect(server!.args[0]).toMatch(/mcp-bridge\/bridge\.mjs$/);
    expect(server!.env).toEqual({
      ONECLI_TOOLS_SOCKET: "/tmp/test-tools.sock",
    });
    // MUTATION-PROOF: flip to shared:true (or drop it) and this fails —
    // the shared pool snapshots config per process, jcode's staleness bug.
    expect(server!.shared).toBe(false);
    expect(statSync(join(home, "mcp.json")).mode & 0o777).toBe(0o600);
  });

  it("deletes every agent-writable MCP override slot — jcode project files merge last and would shadow ours", () => {
    // MUTATION-PROOF: drop any path from the delete list and this fails.
    const dir = makeHome();
    const home = homeOf(dir);
    mkdirSync(join(dir, ".jcode"), { recursive: true });
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(home, "external", ".claude"), { recursive: true });
    mkdirSync(join(dir, ".home", ".jcode"), { recursive: true });
    mkdirSync(join(dir, ".home", ".claude"), { recursive: true });

    const planted = [
      join(dir, ".jcode", "mcp.json"),
      join(dir, ".mcp.json"),
      join(dir, ".claude", "mcp.json"),
      join(home, "external", ".claude.json"),
      join(home, "external", ".claude", "mcp.json"),
      // The durable POSIX home (~ = <homeDir>/.home) mirrors the same
      // override surface now that it persists across relaunch.
      join(dir, ".home", ".jcode", "mcp.json"),
      join(dir, ".home", ".mcp.json"),
      join(dir, ".home", ".claude", "mcp.json"),
      join(dir, ".home", ".claude.json"),
    ];
    for (const path of planted) {
      writeFileSync(path, '{"mcpServers":{"planted":{"command":"evil"}}}');
    }

    prepareMcpConfig(dir, home, "/tmp/test-tools.sock");

    for (const path of planted) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(home, "mcp.json"))).toBe(true);
  });

  it("heals a tampered managed config on the next boot", () => {
    const dir = makeHome();
    const home = homeOf(dir);
    prepareMcpConfig(dir, home, "/tmp/test-tools.sock");

    writeFileSync(join(home, "mcp.json"), '{"mcpServers":{}}', { mode: 0o600 });

    prepareMcpConfig(dir, home, "/tmp/test-tools.sock");
    const config = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.onecli).toBeDefined();
  });
});

describe("resolveMcpBridgePath", () => {
  const layout = (files: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "jcode-bridge-"));
    for (const file of files) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "// bridge stub\n");
    }
    return dir;
  };

  it("resolves the bundle layout: bridge beside the module (dist/)", () => {
    const dir = layout(["dist/mcp-bridge/bridge.mjs"]);
    const moduleUrl = pathToFileURL(join(dir, "dist", "index.mjs")).href;
    expect(resolveMcpBridgePath(moduleUrl)).toBe(
      join(dir, "dist", "mcp-bridge", "bridge.mjs"),
    );
  });

  it("resolves the src layout: bridge one level above the module (src/harness/)", () => {
    const dir = layout(["src/mcp-bridge/bridge.mjs"]);
    const moduleUrl = pathToFileURL(
      join(dir, "src", "harness", "jcode.ts"),
    ).href;
    expect(resolveMcpBridgePath(moduleUrl)).toBe(
      join(dir, "src", "mcp-bridge", "bridge.mjs"),
    );
  });

  it("refuses to guess when the bridge exists in neither layout", () => {
    const dir = layout([]);
    const moduleUrl = pathToFileURL(join(dir, "dist", "index.mjs")).href;
    // MUTATION-PROOF: replace the throw with a fallback path and this fails —
    // a missing bridge must break the boot, not the first agent tool call.
    expect(() => resolveMcpBridgePath(moduleUrl)).toThrow(/bridge\.mjs/);
  });
});
