import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createDockerStreamDemuxer } from "./demux";

const frame = (streamType: number, payload: string): Buffer => {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

const harness = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const drain = (stream: PassThrough): string => {
    const chunk: unknown = stream.read();
    return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
  };
  return {
    demuxer: createDockerStreamDemuxer({ stdout, stderr }),
    out: () => drain(stdout),
    err: () => drain(stderr),
  };
};

describe("createDockerStreamDemuxer", () => {
  it("routes stdout and stderr frames to their sinks", () => {
    const h = harness();
    h.demuxer.write(
      Buffer.concat([frame(1, "hello "), frame(2, "oops"), frame(1, "world")]),
    );
    expect(h.out()).toBe("hello world");
    expect(h.err()).toBe("oops");
  });

  it("reassembles a header split across chunks", () => {
    const h = harness();
    const whole = frame(1, "split-header");
    h.demuxer.write(whole.subarray(0, 3));
    h.demuxer.write(whole.subarray(3, 6));
    h.demuxer.write(whole.subarray(6));
    expect(h.out()).toBe("split-header");
  });

  it("reassembles a payload split across chunks", () => {
    const h = harness();
    const whole = frame(2, "0123456789");
    h.demuxer.write(whole.subarray(0, 12));
    h.demuxer.write(whole.subarray(12));
    expect(h.err()).toBe("0123456789");
  });

  it("skips zero-length frames without desyncing", () => {
    const h = harness();
    h.demuxer.write(Buffer.concat([frame(1, ""), frame(2, "after-empty")]));
    expect(h.out()).toBe("");
    expect(h.err()).toBe("after-empty");
  });

  it("drops unknown stream types payload-intact, framing preserved", () => {
    const h = harness();
    h.demuxer.write(
      Buffer.concat([frame(7, "future"), frame(1, "still-works")]),
    );
    expect(h.out()).toBe("still-works");
    expect(h.err()).toBe("");
  });
});
