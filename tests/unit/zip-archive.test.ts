import { describe, expect, it } from 'vitest';
import { createZipArchive } from '@/lib/archive/zip';

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

describe('createZipArchive()', () => {
  it('creates a basic zip archive with local and central directory records', () => {
    const archive = createZipArchive([
      { name: 'cve.json', content: '{"total":1}' },
      { name: 'licenses.json', content: '{"count":0}' },
    ]);

    expect(readUint32LE(archive, 0)).toBe(0x04034b50);
    expect(new TextDecoder().decode(archive)).toContain('cve.json');
    expect(new TextDecoder().decode(archive)).toContain('licenses.json');
    expect(readUint32LE(archive, archive.length - 22)).toBe(0x06054b50);
  });
});
