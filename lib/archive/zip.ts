const textEncoder = new TextEncoder();

export interface ZipEntry {
  name: string;
  content: string | Uint8Array;
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toUint8Array(content: ZipEntry['content']): Uint8Array {
  return typeof content === 'string' ? textEncoder.encode(content) : content;
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function getDosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

export function createZipArchive(entries: ZipEntry[]): Uint8Array {
  const now = getDosDateTime(new Date());
  const files: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fileName = textEncoder.encode(entry.name);
    const content = toUint8Array(entry.content);
    const checksum = crc32(content);

    const localHeader = new Uint8Array(30 + fileName.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, now.time);
    writeUint16(localView, 12, now.date);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, content.length);
    writeUint32(localView, 22, content.length);
    writeUint16(localView, 26, fileName.length);
    writeUint16(localView, 28, 0);
    localHeader.set(fileName, 30);

    files.push(localHeader, content);

    const centralHeader = new Uint8Array(46 + fileName.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, now.time);
    writeUint16(centralView, 14, now.date);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, content.length);
    writeUint32(centralView, 24, content.length);
    writeUint16(centralView, 28, fileName.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    centralHeader.set(fileName, 46);

    centralDirectory.push(centralHeader);
    offset += localHeader.length + content.length;
  }

  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  return concatChunks([...files, ...centralDirectory, endRecord]);
}
