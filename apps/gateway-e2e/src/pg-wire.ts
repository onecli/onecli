import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A minimal PostgreSQL wire client, for the front door scenarios `psql`
 * cannot drive: hand-built extended-protocol batches (`Parse` / `Bind` /
 * `Execute` with names a driver would never pick), and a session that stays
 * open while the test changes the agent's grants underneath it.
 *
 * It speaks to the gateway only: TLS by `SSLRequest`, a startup packet, the
 * agent token as the cleartext password the gateway asks for. Every server
 * message is returned in arrival order, so a test asserts on exactly what
 * the gateway put on the wire.
 */

const SSL_REQUEST = 80_877_103;
const PROTOCOL_3 = 3 << 16;
const DEFAULT_TIMEOUT_MS = 15_000;

/** One message from the server. */
export interface ServerMessage {
  readonly tag: string;
  readonly body: Buffer;
}

/** What the server answered to one batch, up to its `ReadyForQuery`. */
export interface BatchResult {
  /** Every `DataRow`'s columns as text (`null` for SQL NULL). */
  readonly rows: ReadonlyArray<ReadonlyArray<string | null>>;
  /** Every `ErrorResponse`, by SQLSTATE and message. */
  readonly errors: ReadonlyArray<{ code: string; message: string }>;
  /** `CommandComplete` tags. */
  readonly commands: ReadonlyArray<string>;
  /** The `ReadyForQuery` transaction status (`I`, `T` or `E`). */
  readonly status: string;
}

const frame = (tag: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.write(tag, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

const cstring = (text: string): Buffer =>
  Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);

/** Extended-protocol messages, built as a driver builds them. */
export const message = {
  query: (sql: string): Buffer => frame("Q", cstring(sql)),
  parse: (name: string, sql: string): Buffer =>
    frame(
      "P",
      Buffer.concat([cstring(name), cstring(sql), Buffer.from([0, 0])]),
    ),
  /** No parameters, every result column in text. */
  bind: (portal: string, statement: string): Buffer =>
    frame(
      "B",
      Buffer.concat([
        cstring(portal),
        cstring(statement),
        Buffer.from([0, 0, 0, 0, 0, 0]),
      ]),
    ),
  execute: (portal: string): Buffer =>
    frame("E", Buffer.concat([cstring(portal), Buffer.alloc(4)])),
  flush: (): Buffer => frame("H", Buffer.alloc(0)),
  sync: (): Buffer => frame("S", Buffer.alloc(0)),
} as const;

/** Reads whole messages off a socket, in order. */
class MessageReader {
  private buffered = Buffer.alloc(0);
  private readonly waiting: Array<() => void> = [];
  private ended: Error | undefined;

  constructor(socket: Socket | TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.wake();
    });
    socket.on("close", () => {
      this.ended ??= new Error("the gateway closed the connection");
      this.wake();
    });
    socket.on("error", (error: Error) => {
      this.ended = error;
      this.wake();
    });
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  async next(): Promise<ServerMessage> {
    for (;;) {
      if (this.buffered.length >= 5) {
        const length = this.buffered.readInt32BE(1);
        if (this.buffered.length >= length + 1) {
          const tag = this.buffered.toString("latin1", 0, 1);
          const body = this.buffered.subarray(5, length + 1);
          this.buffered = this.buffered.subarray(length + 1);
          return { tag, body };
        }
      }
      if (this.ended !== undefined) throw this.ended;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }
}

/** One field of an `ErrorResponse` / `NoticeResponse` body. */
const field = (body: Buffer, code: string): string => {
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const end = body.indexOf(0, at + 1);
    if (body.toString("latin1", at, at + 1) === code) {
      return body.toString("utf8", at + 1, end);
    }
    at = end + 1;
  }
  return "";
};

const dataRow = (body: Buffer): Array<string | null> => {
  const columns: Array<string | null> = [];
  let at = 2;
  for (let i = 0; i < body.readInt16BE(0); i++) {
    const length = body.readInt32BE(at);
    at += 4;
    if (length < 0) {
      columns.push(null);
    } else {
      columns.push(body.toString("utf8", at, at + length));
      at += length;
    }
  }
  return columns;
};

/** An open session through the gateway's PostgreSQL front door. */
export interface WireSession {
  /** Send `messages` as one batch and read the answers up to ready. */
  batch(...messages: Buffer[]): Promise<BatchResult>;
  /** Send `messages` without reading anything back. */
  send(...messages: Buffer[]): void;
  /** Read the answers up to the next ready, as `batch` does. */
  untilReady(): Promise<BatchResult>;
  /** The server's next message, whatever it is (a FATAL, say). */
  next(): Promise<ServerMessage>;
  close(): void;
}

export interface WireOptions {
  readonly port: number;
  /** The connection id (the startup packet's `user`). */
  readonly user: string;
  readonly token: string;
  /** More startup parameters (`search_path`, `TimeZone`, ...). */
  readonly parameters?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Open a session: `SSLRequest`, TLS, startup, the token, then ready. */
export const openWireSession = async (
  options: WireOptions,
): Promise<WireSession> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tcp = await new Promise<Socket>((resolve, reject) => {
    const socket = netConnect(options.port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
  const sslRequest = Buffer.alloc(8);
  sslRequest.writeInt32BE(8, 0);
  sslRequest.writeInt32BE(SSL_REQUEST, 4);
  tcp.write(sslRequest);
  const answer = await new Promise<Buffer>((resolve) =>
    tcp.once("data", resolve),
  );
  if (answer.toString("latin1") !== "S") {
    tcp.destroy();
    throw new Error(`the gateway declined TLS: ${answer.toString("latin1")}`);
  }
  // The suite trusts the gateway by its role here, not its certificate:
  // the CA path is pinned by the psql scenarios (`sslmode=verify-ca`).
  const tls = await new Promise<TLSSocket>((resolve, reject) => {
    const socket = tlsConnect(
      { socket: tcp, rejectUnauthorized: false, servername: undefined },
      () => resolve(socket),
    );
    socket.once("error", reject);
  });
  tls.setTimeout(timeoutMs, () =>
    tls.destroy(new Error("the gateway session timed out")),
  );
  const reader = new MessageReader(tls);

  const startup = Buffer.concat([
    Buffer.alloc(4),
    ...Object.entries({ user: options.user, ...options.parameters }).flatMap(
      ([name, value]) => [cstring(name), cstring(value)],
    ),
    Buffer.from([0]),
  ]);
  startup.writeInt32BE(PROTOCOL_3, 0);
  const length = Buffer.alloc(4);
  length.writeInt32BE(startup.length + 4, 0);
  tls.write(Buffer.concat([length, startup]));

  for (;;) {
    const { tag, body } = await reader.next();
    if (tag === "R" && body.readInt32BE(0) === 3) {
      tls.write(frame("p", cstring(options.token)));
    } else if (tag === "E") {
      tls.destroy();
      throw new Error(`login refused: ${field(body, "M")}`);
    } else if (tag === "Z") {
      break;
    }
  }

  const send = (...messages: Buffer[]): void => {
    tls.write(Buffer.concat(messages));
  };
  const untilReady = async (): Promise<BatchResult> => {
    const rows: Array<Array<string | null>> = [];
    const errors: Array<{ code: string; message: string }> = [];
    const commands: string[] = [];
    for (;;) {
      const { tag, body } = await reader.next();
      if (tag === "D") rows.push(dataRow(body));
      if (tag === "E") {
        errors.push({ code: field(body, "C"), message: field(body, "M") });
      }
      if (tag === "C") commands.push(body.toString("utf8", 0, body.length - 1));
      if (tag === "Z") {
        return { rows, errors, commands, status: body.toString("latin1") };
      }
    }
  };
  return {
    batch: (...messages: Buffer[]): Promise<BatchResult> => {
      send(...messages);
      return untilReady();
    },
    send,
    untilReady,
    next: () => reader.next(),
    close: () => {
      tls.end(frame("X", Buffer.alloc(0)));
    },
  };
};

/** The fields of an `ErrorResponse` body a test asserts on. */
export const errorOf = (
  body: Buffer,
): { code: string; severity: string; message: string } => ({
  code: field(body, "C"),
  severity: field(body, "S"),
  message: field(body, "M"),
});
