import { promisify } from "node:util";
import { crc32, inflateRaw } from "node:zlib";

/**
 * A small, strict ZIP reader for skill imports (PKWARE APPNOTE 6.3): no
 * dependency, never trusts a declared size, never follows a link. Reads the
 * central directory (the authoritative file list), then inflates each wanted
 * entry off the event loop with a hard output cap, so a zip bomb fails at
 * the cap instead of filling memory, and checks every entry's CRC-32.
 *
 * Supports what real skill zips use: stored (0) and deflate (8) entries,
 * Unix modes from the "external attributes" field (symlinks and the exec
 * bit). Encrypted, ZIP64 and multi-disk archives are refused with a reason,
 * and so is a zip whose entries share or overlap their data (the
 * overlapping-file bomb: one small record inflated once per entry).
 */

export interface ZipEntry {
  /** The path as stored, "/" separated (a Windows "\" becomes "/"). */
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Any of the Unix exec bits was set by the tool that made the zip. */
  executable: boolean;
  /** Declared uncompressed size: a hint for early refusal only. */
  declaredSize: number;
  /** Inflate this entry, refusing to produce more than `maxBytes`. */
  read: (maxBytes: number) => Promise<Buffer>;
}

/** `too_large`: the entry inflates past the cap it was read with. */
export class ZipError extends Error {
  readonly code: "invalid" | "too_large";
  constructor(message: string, code: "invalid" | "too_large" = "invalid") {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

const inflate = promisify(inflateRaw);

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_BYTES = 22;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_BYTES = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_BYTES = 30;
/** A 16- or 32-bit field at its maximum means "see the ZIP64 record". */
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const MADE_BY_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

const damaged = () => new ZipError("The zip is damaged");
const zip64 = () => new ZipError("Very large (ZIP64) zips aren't supported");
const tooLarge = () => new ZipError("too large", "too_large");

/** The end-of-central-directory record: the last signature whose comment
 * length ends exactly at the end of the file (a signature inside the
 * comment itself can't match that). */
const findEndOfCentralDirectory = (buf: Buffer): number => {
  const floor = Math.max(0, buf.length - EOCD_BYTES - ZIP64_16);
  for (let at = buf.length - EOCD_BYTES; at >= floor; at -= 1) {
    if (
      buf.readUInt32LE(at) === EOCD_SIGNATURE &&
      at + EOCD_BYTES + buf.readUInt16LE(at + 20) === buf.length
    ) {
      return at;
    }
  }
  throw new ZipError("This isn't a zip file");
};

/** List a zip's entries (lazy: nothing is inflated until `read`). */
export const readZip = (buf: Buffer, maxEntries: number): ZipEntry[] => {
  if (buf.length < EOCD_BYTES) throw new ZipError("This isn't a zip file");
  const eocd = findEndOfCentralDirectory(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const onThisDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (total === ZIP64_16 || centralOffset === ZIP64_32) throw zip64();
  if (disk !== 0 || centralDisk !== 0 || onThisDisk !== total) {
    throw new ZipError("Multi-part zips aren't supported");
  }
  if (total > maxEntries) {
    throw new ZipError(
      `The zip holds ${total} entries; the limit is ${maxEntries}`,
    );
  }
  if (centralOffset + centralSize > eocd) throw damaged();

  const entries: ZipEntry[] = [];
  // Each entry's local record [start, end): checked below never to overlap,
  // the way an overlapping-file bomb makes one small record inflate once per
  // entry that points into it.
  const spans: [number, number][] = [];
  let at = centralOffset;
  for (let i = 0; i < total; i += 1) {
    if (
      at + CENTRAL_BYTES > eocd ||
      buf.readUInt32LE(at) !== CENTRAL_SIGNATURE
    ) {
      throw damaged();
    }
    const madeBy = buf.readUInt16LE(at + 4) >> 8;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const declaredSize = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const externalAttrs = buf.readUInt32LE(at + 38);
    const localOffset = buf.readUInt32LE(at + 42);
    const next = at + CENTRAL_BYTES + nameLength + extraLength + commentLength;
    if (next > eocd) throw damaged();
    // Bit 11 = UTF-8 names; otherwise CP437, which matches UTF-8 for ASCII
    // (anything else is refused later by the path rules). Old Windows tools
    // write "\" as the separator: APPNOTE 4.4.17 requires "/".
    const path = buf
      .subarray(at + CENTRAL_BYTES, at + CENTRAL_BYTES + nameLength)
      .toString(flags & FLAG_UTF8 ? "utf8" : "latin1")
      .replaceAll("\\", "/");
    at = next;

    // Unix tools put the file mode in the high 16 bits.
    const mode = madeBy === MADE_BY_UNIX ? externalAttrs >>> 16 : 0;
    const isSymlink = (mode & S_IFMT) === S_IFLNK;
    const isDirectory = path.endsWith("/") || (mode & S_IFMT) === S_IFDIR;
    const isZip64 =
      compressedSize === ZIP64_32 ||
      declaredSize === ZIP64_32 ||
      localOffset === ZIP64_32;
    // The data lives after the local header and its own name and extra
    // field, all before the central directory.
    let start = 0;
    if (!isZip64) {
      if (
        localOffset + LOCAL_BYTES > centralOffset ||
        buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
      ) {
        throw damaged();
      }
      start =
        localOffset +
        LOCAL_BYTES +
        buf.readUInt16LE(localOffset + 26) +
        buf.readUInt16LE(localOffset + 28);
      if (start + compressedSize > centralOffset) throw damaged();
      spans.push([localOffset, start + compressedSize]);
    }
    const end = start + compressedSize;

    const read = async (maxBytes: number): Promise<Buffer> => {
      if (isZip64) throw zip64();
      if (flags & FLAG_ENCRYPTED) {
        throw new ZipError("Password-protected files can't be read");
      }
      const data = buf.subarray(start, end);
      let out: Buffer;
      if (method === 0) {
        if (data.length > maxBytes) throw tooLarge();
        out = Buffer.from(data);
      } else if (method === 8) {
        try {
          // maxOutputLength makes zlib stop at the cap: the bomb guard
          // (it must be ≥ 1, so an empty room is checked after).
          out = await inflate(data, {
            maxOutputLength: Math.max(1, maxBytes),
          });
        } catch (err) {
          throw err instanceof Error &&
            "code" in err &&
            err.code === "ERR_BUFFER_TOO_LARGE"
            ? tooLarge()
            : damaged();
        }
        if (out.length > maxBytes) throw tooLarge();
      } else {
        throw new ZipError("This zip uses an unsupported compression");
      }
      if (crc32(out) !== crc) throw damaged();
      return out;
    };

    entries.push({
      path,
      isDirectory,
      isSymlink,
      executable: (mode & 0o111) !== 0,
      declaredSize,
      read,
    });
  }
  let previousEnd = 0;
  for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
    if (from < previousEnd) throw damaged();
    previousEnd = to;
  }
  return entries;
};
