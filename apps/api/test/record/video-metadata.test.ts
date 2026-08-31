import { describe, expect, it } from 'vitest';
import { extractVideoCapturedAt } from '../../src/record/video-metadata.js';

const MAC_EPOCH_OFFSET_SECONDS = 2_082_844_800;

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/** A minimal, well-formed `mvhd` box (version 0 — 32-bit times). */
function mvhdV0(creationSeconds: number): Buffer {
  const body = Buffer.alloc(20);
  body.writeUInt32BE(0, 0); // version(1) + flags(3), all zero
  body.writeUInt32BE(creationSeconds, 4); // creation_time
  body.writeUInt32BE(0, 8); // modification_time
  body.writeUInt32BE(1000, 12); // timescale
  body.writeUInt32BE(0, 16); // duration
  return box('mvhd', body);
}

/** The 64-bit-time variant (version 1). */
function mvhdV1(creationSeconds: number): Buffer {
  const body = Buffer.alloc(32);
  body.writeUInt32BE(1 << 24, 0); // version = 1, flags = 0
  const big = BigInt(creationSeconds);
  body.writeUInt32BE(Number(big >> 32n), 4);
  body.writeUInt32BE(Number(big & 0xffffffffn), 8);
  return box('mvhd', body);
}

function fileWith(mvhd: Buffer): Buffer {
  const ftyp = box('ftyp', Buffer.from('isommp42', 'ascii'));
  const moov = box('moov', mvhd);
  return Buffer.concat([ftyp, moov]);
}

function isoOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function macSecondsFor(date: Date): number {
  return Math.floor(date.getTime() / 1000) + MAC_EPOCH_OFFSET_SECONDS;
}

describe('extractVideoCapturedAt', () => {
  it('reads a version-0 mvhd creation time as a naive UTC wall-clock string', () => {
    const when = new Date(Date.UTC(2024, 0, 15, 10, 30, 5));
    const buf = fileWith(mvhdV0(macSecondsFor(when)));
    expect(extractVideoCapturedAt(buf)).toBe(isoOf(when));
  });

  it('reads a version-1 (64-bit) mvhd creation time identically', () => {
    const when = new Date(Date.UTC(2023, 5, 1, 23, 59, 1));
    const buf = fileWith(mvhdV1(macSecondsFor(when)));
    expect(extractVideoCapturedAt(buf)).toBe(isoOf(when));
  });

  it('returns null when there is no moov box at all', () => {
    const buf = box('ftyp', Buffer.from('isommp42', 'ascii'));
    expect(extractVideoCapturedAt(buf)).toBeNull();
  });

  it('returns null when moov has no mvhd child', () => {
    const moov = box('moov', box('trak', Buffer.alloc(4)));
    expect(extractVideoCapturedAt(moov)).toBeNull();
  });

  it('returns null when the creation time was never set (all zero)', () => {
    const buf = fileWith(mvhdV0(0));
    expect(extractVideoCapturedAt(buf)).toBeNull();
  });

  it('returns null for a truncated or malformed buffer rather than throwing', () => {
    expect(extractVideoCapturedAt(Buffer.from([0, 0, 0]))).toBeNull();
    expect(extractVideoCapturedAt(Buffer.alloc(0))).toBeNull();

    const truncatedMvhd = box('moov', Buffer.from([0x6d, 0x76, 0x68, 0x64])); // 'mvhd' header claims a body that isn't there
    expect(extractVideoCapturedAt(truncatedMvhd)).toBeNull();
  });

  it('finds moov even when it is not the first top-level box (a non-fast-start file)', () => {
    const ftyp = box('ftyp', Buffer.from('isommp42', 'ascii'));
    const mdat = box('mdat', Buffer.from('pretend media data'));
    const when = new Date(Date.UTC(2022, 2, 3, 4, 5, 6));
    const moov = box('moov', mvhdV0(macSecondsFor(when)));
    const buf = Buffer.concat([ftyp, mdat, moov]);
    expect(extractVideoCapturedAt(buf)).toBe(isoOf(when));
  });
});
