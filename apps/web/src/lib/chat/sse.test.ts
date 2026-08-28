import { describe, expect, it } from "vitest";
import {
  initialSseState,
  parseTranscriptFrame,
  pushSseChunk,
  type SseFrame,
  type SseParserState,
} from "./sse";

const EVENT_JSON = JSON.stringify({
  seq: 7,
  turnId: "t1",
  type: "text.delta",
  payload: { type: "text.delta", text: "hi" },
});

const FRAME = `id: 7\nevent: transcript\ndata: ${EVENT_JSON}\n\n`;

/** Feed a string through the parser in arbitrary slices, collecting frames. */
const feed = (chunks: string[]): SseFrame[] => {
  let state: SseParserState = initialSseState;
  const frames: SseFrame[] = [];
  for (const chunk of chunks) {
    const pushed = pushSseChunk(state, chunk);
    state = pushed.state;
    frames.push(...pushed.frames);
  }
  return frames;
};

describe("pushSseChunk", () => {
  it("parses one complete frame in one chunk", () => {
    const frames = feed([FRAME]);
    expect(frames).toEqual([
      { id: "7", event: "transcript", data: EVENT_JSON },
    ]);
  });

  it("parses identically when fed one character at a time", () => {
    const frames = feed(FRAME.split(""));
    expect(frames).toEqual([
      { id: "7", event: "transcript", data: EVENT_JSON },
    ]);
  });

  it("joins multi-line data with newlines and strips exactly one space", () => {
    const frames = feed(["data: a\ndata:no-space\ndata:  two\n\n"]);
    expect(frames).toEqual([{ event: "message", data: "a\nno-space\n two" }]);
  });

  it("keeps keepalive comments invisible, even inside an accumulating frame", () => {
    expect(feed([": keep-alive\n\n"])).toEqual([]);
    const frames = feed([
      `id: 7\n: keep-alive\nevent: transcript\ndata: x\n\n`,
    ]);
    expect(frames).toEqual([{ id: "7", event: "transcript", data: "x" }]);
  });

  it("treats CRLF like LF, including a CRLF split across chunks", () => {
    const crlf = FRAME.replace(/\n/g, "\r\n");
    expect(feed([crlf])).toEqual(feed([FRAME]));

    const splitAt = crlf.indexOf("\r\n\r\n") + 1; // between the \r and the \n
    expect(feed([crlf.slice(0, splitAt), crlf.slice(splitAt)])).toEqual(
      feed([FRAME]),
    );
  });

  it("dispatches nothing for a frame with no data lines", () => {
    expect(feed(["id: 3\nevent: transcript\n\n"])).toEqual([]);
  });

  it("delivers two frames in one chunk, in order", () => {
    const frames = feed(["data: one\n\ndata: two\n\n"]);
    expect(frames.map((f) => f.data)).toEqual(["one", "two"]);
  });
});

describe("parseTranscriptFrame", () => {
  const frame = (overrides: Partial<SseFrame>): SseFrame => ({
    event: "transcript",
    data: EVENT_JSON,
    ...overrides,
  });

  it("decodes a valid transcript frame", () => {
    expect(parseTranscriptFrame(frame({}))).toEqual({
      seq: 7,
      turnId: "t1",
      type: "text.delta",
      payload: { type: "text.delta", text: "hi" },
    });
  });

  it("ignores other event names", () => {
    expect(parseTranscriptFrame(frame({ event: "message" }))).toBeNull();
  });

  it("ignores malformed JSON", () => {
    expect(
      parseTranscriptFrame(frame({ data: EVENT_JSON.slice(0, 10) })),
    ).toBeNull();
  });

  it("ignores payloads missing their shape", () => {
    const without = (key: string) => {
      const obj = JSON.parse(EVENT_JSON) as Record<string, unknown>;
      delete obj[key];
      return JSON.stringify(obj);
    };
    expect(parseTranscriptFrame(frame({ data: without("seq") }))).toBeNull();
    expect(parseTranscriptFrame(frame({ data: without("turnId") }))).toBeNull();
    expect(
      parseTranscriptFrame(frame({ data: without("payload") })),
    ).toBeNull();
    expect(parseTranscriptFrame(frame({ data: '"just a string"' }))).toBeNull();
    expect(
      parseTranscriptFrame(frame({ data: EVENT_JSON.replace("7", '"7"') })),
    ).toBeNull();
  });
});
