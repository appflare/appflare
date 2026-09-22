/**
 * A tiny, dependency-free ZIP writer that emits STORE (method 0, uncompressed)
 * archives. Uncompressed is a deliberate artifact-format choice:
 * the manager Range-fetches one file at a time straight from the
 * release asset without decompressing anything inside a Worker.
 *
 * Only the classic 32-bit ZIP structures are produced (local file headers,
 * central directory, end-of-central-directory). ZIP64 is not implemented; the
 * builder throws if any size, offset, or the entry count would overflow 32 bits.
 * That is fine for artifacts, which are small.
 */

/** IEEE 802.3 CRC-32 lookup table, built once. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte buffer, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    // biome-ignore lint/style/noNonNullAssertion: 8-bit index is always in range.
    c = (CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (1980-01-01 00:00:00) so archives are reproducible given
// the same inputs. The artifact's real build time lives in manifest.json.
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// General-purpose bit 11 set => filename bytes are UTF-8. Bit 3 (data descriptor)
// is left clear: every size and CRC is known up front and written in the header.
const FLAG_UTF8 = 0x0800;
const VERSION = 20; // 2.0
const U32_MAX = 0xffffffff;

/** One STORE entry's placement inside the archive. */
export interface ZipEntryPlacement {
  /** Byte offset of the entry's file data, i.e. just past its local header. */
  dataOffset: number;
}

/**
 * Builds a STORE zip incrementally. Call {@link addFile} for each entry in the
 * order they should appear, using the returned `dataOffset` as the manifest's
 * byte offset, then {@link finish} to get the archive bytes.
 */
export class ZipStore {
  #chunks: Buffer[] = [];
  #central: Buffer[] = [];
  #offset = 0;
  #count = 0;

  #push(buf: Buffer): void {
    this.#chunks.push(buf);
    this.#offset += buf.length;
  }

  /** Appends one file. Returns the byte offset of its data within the archive. */
  addFile(name: string, data: Uint8Array): ZipEntryPlacement {
    const nameBytes = Buffer.from(name, "utf8");
    const size = data.length;
    const localHeaderOffset = this.#offset;
    if (localHeaderOffset > U32_MAX || size > U32_MAX) {
      throw new Error(`zip entry "${name}" exceeds 32-bit ZIP limits (ZIP64 unsupported)`);
    }
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // method 0 = STORE
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size == uncompressed for STORE
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    this.#push(local);
    this.#push(nameBytes);

    const dataOffset = this.#offset;
    this.#push(Buffer.from(data));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIR_SIG, 0);
    central.writeUInt16LE(VERSION, 4); // version made by
    central.writeUInt16LE(VERSION, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(localHeaderOffset, 42);
    this.#central.push(Buffer.concat([central, nameBytes]));

    this.#count++;
    return { dataOffset };
  }

  /** Serializes the central directory + EOCD and returns the full archive. */
  finish(): Buffer {
    if (this.#count > 0xffff) {
      throw new Error(`too many zip entries (${this.#count}); ZIP64 unsupported`);
    }
    const centralStart = this.#offset;
    const central = Buffer.concat(this.#central);
    if (centralStart > U32_MAX || central.length > U32_MAX) {
      throw new Error("zip central directory exceeds 32-bit ZIP limits (ZIP64 unsupported)");
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // this disk number
    eocd.writeUInt16LE(0, 6); // disk with central dir
    eocd.writeUInt16LE(this.#count, 8);
    eocd.writeUInt16LE(this.#count, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...this.#chunks, central, eocd]);
  }
}
