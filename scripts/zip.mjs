/**
 * Minimal deterministic ZIP writer.
 *
 * The Chrome Web Store wants a zip, and the one that used to sit in `dist/` was
 * assembled by hand. It drifted: thirteen of its twenty-two entries were older
 * than the working tree, including `popup.js` and `background.js`. Generating the
 * archive from the same `dist/` the build just produced is the only way that
 * cannot happen again.
 *
 * Node already ships deflate and a store-format zip is a few dozen lines, so
 * there is no dependency and no shelling out to a `zip` binary that a stock
 * Windows machine does not have.
 *
 * Every entry gets a fixed 1980-01-01 timestamp, so building the same source
 * twice produces a byte-identical archive and two releases can be diffed.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 1980-01-01 00:00:00 in DOS date/time form. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * @param {Array<{ name: string, data: Buffer }>} files
 *   `name` uses forward slashes and is relative to the archive root.
 * @returns {Buffer}
 */
export function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Tiny or incompressible entries can grow when deflated; store those.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // no flags: sizes are known up front
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0o644 << 16, 38); // external attributes: regular file
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...locals, centralDirectory, eocd]);
}

/**
 * Read an archive back and verify it, entry by entry.
 *
 * A hand-rolled zip writer is exactly the kind of code that appears to work
 * (the file exists, it has a plausible size) while producing something the Web
 * Store rejects. So the build parses its own output through the central
 * directory, inflates every entry and checks each CRC against the stored one. A
 * malformed archive fails the build instead of the upload.
 *
 * @param {Buffer} archive
 * @returns {Array<{ name: string, size: number }>}
 */
export function verifyZip(archive) {
  const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) throw new Error('zip: no end-of-central-directory record');

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const directorySize = archive.readUInt32LE(eocdOffset + 12);
  const directoryOffset = archive.readUInt32LE(eocdOffset + 16);
  if (directoryOffset + directorySize > archive.length) {
    throw new Error('zip: central directory runs past the end of the file');
  }

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`zip: bad central directory header for entry ${index}`);
    }
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (archive.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip: bad local header for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = archive.subarray(bodyStart, bodyStart + compressedSize);
    const data = method === METHOD_DEFLATE ? inflateRawSync(body) : body;

    if (data.length !== uncompressedSize) {
      throw new Error(`zip: ${name} inflated to ${data.length}, expected ${uncompressedSize}`);
    }
    if (crc32(data) !== expectedCrc) throw new Error(`zip: checksum mismatch for ${name}`);

    entries.push({ name, size: uncompressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
