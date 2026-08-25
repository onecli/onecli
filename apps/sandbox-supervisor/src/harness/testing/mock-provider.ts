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
 * live against v0.78.1 to bind fresh sessions to this provider.
 */
import { createServer, type Server } from "node:http";

export const LONG_RUN_MARKER = "LONGRUN";
export const FINAL_ANSWER_MARKER = "THE-FINAL-ANSWER";

export interface MockProvider {
  server: Server;
  port: number;
  /** One entry per /chat/completions request: when, and the routed kind. */
  requests: { at: number; kind: "long" | "quick" }[];
  close: () => Promise<void>;
}

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

export const startMockProvider = (options: {
  longMs: number;
  keepaliveMs: number;
}): Promise<MockProvider> =>
  new Promise((resolve) => {
    const requests: MockProvider["requests"] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (piece: Buffer) => (body += piece.toString()));
      req.on("end", () => {
        if (!req.url?.includes("/chat/completions")) {
          res.writeHead(404).end();
          return;
        }
        const long = lastUserContent(body).includes(LONG_RUN_MARKER);
        requests.push({ at: Date.now(), kind: long ? "long" : "quick" });
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
