/* global process, console */
// The OneCLI platform-tools MCP bridge (step 7).
//
// jcode speaks MCP to STDIO CHILDREN ONLY — it spawns this file per session
// (mcp.json, written by the supervisor's jcode adapter). All this process
// does is adapt protocols: MCP over stdio on one side, the supervisor's
// JSONL Unix socket on the other. Tool NAMES, SCHEMAS, and HANDLERS all live
// elsewhere (the supervisor advertises, the control plane executes) — the
// bridge is deliberately too dumb to need updating when a capability lands.
//
// Plain ESM JavaScript, deliberately: it is spawned as `process.execPath`
// (the exact node binary already running the supervisor) with this file's
// absolute path — no tsx, no build step, no PATH assumptions, in the agent
// image and the dev loop alike. The SDK resolves from this package's own
// node_modules.
//
// The low-level Server API (setRequestHandler + plain JSON Schemas) rather
// than the zod-flavored McpServer: the schemas arrive serialized from the
// supervisor, and re-hydrating them into a validator here would duplicate
// the control plane's authority (the api's zod is the enforcement; jcode
// already shows the JSON schema to the model).

import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SOCKET_PATH = process.env.ONECLI_TOOLS_SOCKET;
if (!SOCKET_PATH) {
  console.error("ONECLI_TOOLS_SOCKET is not set; refusing to start.");
  process.exit(1);
}

/** One JSONL request/response channel to the supervisor. */
const socket = createConnection(SOCKET_PATH);
socket.setEncoding("utf8");

/** @type {Map<string, (response: any) => void>} */
const pending = new Map();
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = message?.id ? pending.get(message.id) : undefined;
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

// The supervisor going away means every future call would hang against a
// dead socket; failing pending calls NOW turns that into tool errors the
// model can read, and jcode survives a dead MCP child (calls error; it does
// not crash the session).
const failAllPending = (reason) => {
  for (const [, resolve] of pending) {
    resolve({ ok: false, error: reason });
  }
  pending.clear();
};
socket.on("error", () => failAllPending("The platform tool channel is down."));
socket.on("close", () => failAllPending("The platform tool channel closed."));

/** @param {Record<string, unknown>} request */
const ask = (request) =>
  new Promise((resolve) => {
    const id = randomUUID();
    pending.set(id, resolve);
    if (socket.destroyed) {
      pending.delete(id);
      resolve({ ok: false, error: "The platform tool channel is down." });
      return;
    }
    socket.write(`${JSON.stringify({ id, ...request })}\n`);
  });

const main = async () => {
  // Tool definitions come from the supervisor at startup — the bridge never
  // hardcodes a capability.
  const advertised = await ask({ op: "tools" });
  const tools = advertised?.ok && Array.isArray(advertised.tools)
    ? advertised.tools
    : [];

  const server = new Server(
    { name: "onecli", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const answer = await ask({
      op: "call",
      tool: request.params.name,
      args: request.params.arguments ?? {},
    });
    if (!answer?.ok) {
      return {
        content: [
          { type: "text", text: String(answer?.error ?? "Tool call failed") },
        ],
        isError: true,
      };
    }
    const result = answer.result;
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result),
        },
      ],
    };
  });

  await server.connect(new StdioServerTransport());
};

main().catch((error) => {
  console.error(`platform-tools bridge failed: ${String(error)}`);
  process.exit(1);
});
