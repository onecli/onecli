/**
 * Mock OpenAI-compatible model provider for the LIVE jcode suites.
 *
 * Serves `POST <base>/chat/completions` as SSE. A request whose LAST user
 * message contains "LONGRUN" streams a keepalive delta every `keepaliveMs`
 * and finishes after `longMs` — an arbitrarily long "busy" turn with zero
 * real credentials (the incident's CI-watching turn, minus the wait).
 * Anything else answers fast. Keyed on the last user message, not the whole
 * body, because jcode sends full history — a steer injected after a LONGRUN
 * turn must not re-trigger the long path.
 *
 * jcode is pointed here via a named provider profile in config.toml:
 *
 *   [providers.mockai]
 *   type = "openai-compatible"
 *   base_url = "http://127.0.0.1:<port>/v1"
 *   api_key = "sk-mock"
 *   default_model = "mock-model"
 *   models = [{ id = "mock-model" }]
 *
 * plus `default_model = "mockai:mock-model"` under `[provider]` — verified
 * live against v0.78.1 and v0.81.1 to bind fresh sessions to this provider.
 */
import { createServer, type Server, type ServerResponse } from "node:http";

export const LONG_RUN_MARKER = "LONGRUN";
export const FINAL_ANSWER_MARKER = "THE-FINAL-ANSWER";

/** A scripted assistant reply: plain text, optionally streamed slowly. */
export interface ScriptedText {
  kind: "text";
  text: string;
  /** Stream as these chunks, one per interval — a deliberately long turn. */
  slow?: { chunks: string[]; intervalMs: number };
  /** Recorded on the request entry so tests can await a specific route. */
  tag?: string;
}

/** A scripted OpenAI-style tool call (optionally preceded by text). */
export interface ScriptedToolCall {
  kind: "tool_call";
  name: string;
  /** JSON-encoded arguments object, streamed verbatim. */
  argsJson: string;
  /** Content deltas written before the tool call — a mixed reply. */
  textBefore?: string;
  tag?: string;
}

export type ScriptedResponse = ScriptedText | ScriptedToolCall;

/**
 * Per-request director for scenario tests. Receives the LAST user message
 * (tool results ride role:"tool", so a continuation re-presents the same
 * user text — key any per-route sequencing on closure state, not on the
 * message alone) and the global request index. Returning undefined falls
 * through to the default LONGRUN/quick routing, so a script never has to
 * re-implement it.
 */
export type MockScript = (request: {
  lastUser: string;
  index: number;
}) => ScriptedResponse | undefined;

export interface MockProvider {
  server: Server;
  port: number;
  /** One entry per /chat/completions request: when, the routed kind, for
   * scripted routes the response's tag, and — when the request advertised a
   * fan-out tool — that tool's model-visible description, so a live test can
   * prove the platform's prompt override actually reached the model. */
  requests: {
    at: number;
    kind: "long" | "quick" | "scripted";
    tag?: string;
    swarmToolDescription?: string;
  }[];
  close: () => Promise<void>;
}

/** The fan-out tool's description from an OpenAI-compatible request body. */
const swarmToolDescriptionOf = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as {
      tools?: { function?: { name?: string; description?: string } }[];
    };
    return parsed.tools?.find((tool) => tool.function?.name === "swarm")
      ?.function?.description;
  } catch {
    return undefined;
  }
};

const chunk = (text: string, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: finish ? {} : { content: text },
        finish_reason: finish,
      },
    ],
  })}\n\n`;

/** The last user message's text, however the body nests it. */
const lastUserContent = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as {
      messages?: { role?: string; content?: unknown }[];
    };
    const last = [...(parsed.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    if (!last) return "";
    return typeof last.content === "string"
      ? last.content
      : JSON.stringify(last.content ?? "");
  } catch {
    return body;
  }
};

/** One SSE chunk with a raw delta object (role/content/tool_calls). */
const rawChunk = (delta: object, finish: string | null, usage = false) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage && {
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  })}\n\n`;

/**
 * Write a scripted response as OpenAI-compatible SSE. Tool calls stream the
 * canonical three-part shape (role → tool_calls delta → finish_reason
 * "tool_calls"); slow text writes one content delta per interval so a
 * scenario can hold a turn open mid-stream deliberately.
 */
const serveScripted = (
  res: ServerResponse,
  scripted: ScriptedResponse,
): void => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(rawChunk({ role: "assistant" }, null));
  const finish = (reason: string) => {
    res.write(rawChunk({}, reason, true));
    res.write("data: [DONE]\n\n");
    res.end();
  };
  if (scripted.kind === "tool_call") {
    if (scripted.textBefore)
      res.write(rawChunk({ content: scripted.textBefore }, null));
    res.write(
      rawChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${Date.now()}`,
              type: "function",
              function: { name: scripted.name, arguments: scripted.argsJson },
            },
          ],
        },
        null,
      ),
    );
    finish("tool_calls");
    return;
  }
  if (!scripted.slow) {
    res.write(rawChunk({ content: scripted.text }, null));
    finish("stop");
    return;
  }
  const chunks = [...scripted.slow.chunks];
  const timer = setInterval(() => {
    const next = chunks.shift();
    if (next !== undefined) {
      res.write(rawChunk({ content: next }, null));
      return;
    }
    clearInterval(timer);
    if (scripted.text) res.write(rawChunk({ content: scripted.text }, null));
    finish("stop");
  }, scripted.slow.intervalMs);
  // Same law as the LONGRUN path below: the RESPONSE closing (the daemon
  // cancelling the run) is the stop signal, never the request stream.
  res.on("close", () => clearInterval(timer));
};

export const startMockProvider = (options: {
  longMs: number;
  keepaliveMs: number;
  script?: MockScript;
}): Promise<MockProvider> =>
  new Promise((resolve) => {
    const requests: MockProvider["requests"] = [];
    let served = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (piece: Buffer) => (body += piece.toString()));
      req.on("end", () => {
        if (!req.url?.includes("/chat/completions")) {
          res.writeHead(404).end();
          return;
        }
        const swarmToolDescription = swarmToolDescriptionOf(body);
        const scripted = options.script?.({
          lastUser: lastUserContent(body),
          index: served++,
        });
        if (scripted) {
          requests.push({
            at: Date.now(),
            kind: "scripted",
            tag: scripted.tag,
            ...(swarmToolDescription !== undefined && {
              swarmToolDescription,
            }),
          });
          serveScripted(res, scripted);
          return;
        }
        const long = lastUserContent(body).includes(LONG_RUN_MARKER);
        requests.push({
          at: Date.now(),
          kind: long ? "long" : "quick",
          ...(swarmToolDescription !== undefined && { swarmToolDescription }),
        });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "mock-model",
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          })}\n\n`,
        );
        res.write(
          chunk(long ? "Working on the long task" : "Quick answer", null),
        );
        const finish = () => {
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        };
        if (!long) {
          finish();
          return;
        }
        const keepalive = setInterval(() => {
          res.write(chunk(" ...still working", null));
        }, options.keepaliveMs);
        const done = setTimeout(() => {
          clearInterval(keepalive);
          res.write(chunk(` ${FINAL_ANSWER_MARKER}`, null));
          finish();
        }, options.longMs);
        // res 'close', not req 'close': the REQUEST stream closes as soon as
        // its body is consumed in modern Node, which would clear these timers
        // immediately and leave the SSE hanging open forever. The RESPONSE
        // closes when the peer (jcode cancelling the run) goes away — the
        // signal that actually means "stop streaming".
        res.on("close", () => {
          clearInterval(keepalive);
          clearTimeout(done);
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
