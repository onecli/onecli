/**
 * SSH wire-format primitives (RFC 4251 §5), the subset OpenSSH certificates
 * need: `string` (uint32 length + bytes), `uint32`, and `uint64`. Kept
 * dependency-free on purpose — this package is consumed by both the control
 * plane (cert minting) and the sandbox platform (terminator + broker
 * verification), and a wire codec must not drag either's dependency tree
 * into the other.
 */

export class WireWriter {
  private chunks: Buffer[] = [];

  writeBytes(bytes: Buffer): this {
    this.chunks.push(bytes);
    return this;
  }

  writeString(value: Buffer | string): this {
    const bytes =
      typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    this.chunks.push(len, bytes);
    return this;
  }

  writeUint32(value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value, 0);
    this.chunks.push(buf);
    return this;
  }

  writeUint64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new RangeError(`uint64 out of range: ${value}`);
    }
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(value, 0);
    this.chunks.push(buf);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Cursor-based reader. Every read is bounds-checked and throws on truncation
 * rather than returning partial data — certificate blobs arrive from the
 * network and must never be trusted to be well-formed.
 */
export class WireReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  /** Byte offset of the read cursor — used to capture the to-be-signed span. */
  get position(): number {
    return this.offset;
  }

  readString(): Buffer {
    if (this.remaining < 4) throw new Error("truncated ssh string length");
    const len = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    if (this.remaining < len) throw new Error("truncated ssh string body");
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readUint32(): number {
    if (this.remaining < 4) throw new Error("truncated uint32");
    const out = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return out;
  }

  readUint64(): bigint {
    if (this.remaining < 8) throw new Error("truncated uint64");
    const out = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return out;
  }

  expectEnd(): void {
    if (this.remaining !== 0) {
      throw new Error(`${this.remaining} trailing bytes after ssh structure`);
    }
  }
}

/** Unpack a "packed strings" field (principals list, options, extensions). */
export const readPackedStrings = (packed: Buffer): Buffer[] => {
  const reader = new WireReader(packed);
  const out: Buffer[] = [];
  while (reader.remaining > 0) out.push(reader.readString());
  return out;
};
