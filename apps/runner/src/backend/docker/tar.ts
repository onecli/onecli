/**
 * A minimal USTAR writer — just enough to hand Docker's
 * `PUT /containers/{id}/archive` a set of regular files and the directories
 * they need.
 *
 * Written rather than depended on: the archives are a handful of small files
 * we generate ourselves (the gateway CA, credential stubs), so a tar library
 * would be a dependency carrying an extraction path we never use — and
 * extraction is where tar CVEs live.
 */

const BLOCK = 512;

/**
 * USTAR's name field is 100 bytes, NUL-terminated: 99 usable characters. A
 * longer name must REFUSE, not truncate — a silently shortened path is a
 * wrong path, extracted somewhere nobody asked for. (The `prefix` field could
 * extend this; deliberately unimplemented until a real payload needs it.)
 */
const NAME_MAX = 99;

const writeString = (
  block: Buffer,
  value: string,
  offset: number,
  length: number,
): void => {
  block.write(value.slice(0, length - 1), offset, length - 1, "utf8");
};

/** USTAR numeric fields are octal, NUL-terminated, zero-padded. */
const writeOctal = (
  block: Buffer,
  value: number,
  offset: number,
  length: number,
): void => {
  const text = value.toString(8).padStart(length - 1, "0");
  block.write(text, offset, length - 1, "ascii");
};

interface TarEntryBase {
  /** Path INSIDE the archive, relative (docker resolves it against the
   * extraction directory). */
  path: string;
  mode: number;
  /** The daemon extracts with the header's numeric owner VERBATIM (it runs
   * as root; there is no remapping to the container's user) — so ownership
   * is decided here, by the writer. */
  uid: number;
  gid: number;
}

export type TarEntry =
  | (TarEntryBase & { kind: "file"; content: string })
  | (TarEntryBase & { kind: "directory" });

const header = (entry: TarEntry, size: number): Buffer => {
  // Directory names carry the conventional trailing slash; derived here so a
  // caller cannot produce a dir entry some extractor reads as a file.
  const name =
    entry.kind === "directory" && !entry.path.endsWith("/")
      ? `${entry.path}/`
      : entry.path;
  // Measured in BYTES: the field is 100 bytes and a multi-byte UTF-8 name
  // can overflow it at fewer characters.
  if (Buffer.byteLength(name, "utf8") > NAME_MAX) {
    throw new Error(
      `tar entry name exceeds USTAR's ${NAME_MAX}-byte field: ${name}`,
    );
  }

  const block = Buffer.alloc(BLOCK);
  writeString(block, name, 0, 100);
  writeOctal(block, entry.mode & 0o7777, 100, 8);
  writeOctal(block, entry.uid, 108, 8);
  writeOctal(block, entry.gid, 116, 8);
  writeOctal(block, size, 124, 12);
  // mtime: a fixed epoch, so the same files always produce the same bytes
  // rather than an archive that differs on every build.
  writeOctal(block, 0, 136, 12);
  block.write("        ", 148, 8, "ascii"); // checksum placeholder
  block.write(entry.kind === "directory" ? "5" : "0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeOctal(block, checksum, 148, 7);
  block.write("\0", 154, 1, "ascii");

  return block;
};

const pad = (size: number): Buffer =>
  Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Build a tar archive containing exactly these entries, in order. */
export const buildTar = (entries: TarEntry[]): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory") {
      parts.push(header(entry, 0));
      continue;
    }
    const content = Buffer.from(entry.content, "utf8");
    parts.push(header(entry, content.length), content, pad(content.length));
  }
  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
};
