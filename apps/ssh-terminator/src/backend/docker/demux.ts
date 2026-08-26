import type { Writable } from "node:stream";

/**
 * The Docker multiplexed-stream demultiplexer (Tty=false only; a TTY exec
 * is a raw byte stream). Daemon→client frames are 8-byte header + payload:
 * byte 0 = stream type (1 stdout, 2 stderr), bytes 4-7 = payload length as
 * uint32 BIG-endian. Client→daemon stdin is unframed in both modes.
 *
 * Feed arbitrary chunk boundaries — headers and payloads split across
 * chunks are reassembled; unknown stream types are dropped payload-intact
 * (forward-compatible, never desynced).
 */
export interface DockerStreamDemuxer {
  write(chunk: Buffer): void;
}

const HEADER_SIZE = 8;
const STDOUT = 1;
const STDERR = 2;

export const createDockerStreamDemuxer = (sinks: {
  stdout: Writable;
  stderr: Writable;
  /** Called when a sink reports it is full (write() === false) so the caller
   *  can pause the source until the sink drains — backpressure. */
  onBackpressure?: (sink: Writable) => void;
}): DockerStreamDemuxer => {
  let buffered: Buffer = Buffer.alloc(0);

  return {
    write(chunk) {
      buffered =
        buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < HEADER_SIZE) return;
        const payloadLength = buffered.readUInt32BE(4);
        if (buffered.length < HEADER_SIZE + payloadLength) return;
        const streamType = buffered[0];
        const payload = buffered.subarray(
          HEADER_SIZE,
          HEADER_SIZE + payloadLength,
        );
        buffered = buffered.subarray(HEADER_SIZE + payloadLength);
        if (payload.length === 0) continue;
        const sink =
          streamType === STDOUT
            ? sinks.stdout
            : streamType === STDERR
              ? sinks.stderr
              : null;
        // Type 0 is the daemon echoing stdin (attach semantics) and anything
        // else is future vocabulary — skipped, framing intact.
        if (sink && !sink.write(payload)) sinks.onBackpressure?.(sink);
      }
    },
  };
};
