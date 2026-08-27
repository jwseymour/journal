import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublishedIndexReader } from '../src/index-reader.js';

/**
 * Built against the exact schema `apps/api/src/index/published-index.ts`
 * migrates to — this is the one place this package has to agree with that
 * schema by hand, since it deliberately does not import that module
 * (`src/index-reader.ts`'s doc comment explains why).
 */
function seedSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE published (
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      mirror_key TEXT NOT NULL,
      source_created_at TEXT NOT NULL,
      published_at TEXT NOT NULL,
      source_hash_at_publish TEXT NOT NULL,
      PRIMARY KEY (source_type, source_id)
    );
  `);
}

function insert(
  db: Database.Database,
  row: { sourceType: string; sourceId: string; sourceCreatedAt: string },
): void {
  db.prepare(
    `INSERT INTO published (source_type, source_id, mirror_key, source_created_at, published_at, source_hash_at_publish)
     VALUES (@sourceType, @sourceId, @mirrorKey, @sourceCreatedAt, @sourceCreatedAt, 'hash')`,
  ).run({
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    mirrorKey: `public/${row.sourceType}s/${row.sourceId}.json`,
    sourceCreatedAt: row.sourceCreatedAt,
  });
}

let dir: string;
let dbPath: string;
let seedDb: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'journal-public-index-'));
  dbPath = join(dir, 'index.db');
  seedDb = new Database(dbPath);
  seedSchema(seedDb);
});

afterEach(async () => {
  seedDb.close();
  await rm(dir, { recursive: true, force: true });
});

describe('list', () => {
  it('returns only rows of the requested source type, newest source-created-first', () => {
    insert(seedDb, { sourceType: 'document', sourceId: '01K3F9X2VQ8N7M4TQXYZ8ABC01', sourceCreatedAt: '2026-01-01T00:00:00Z' });
    insert(seedDb, { sourceType: 'entry', sourceId: '01K3F9X2VQ8N7M4TQXYZ8ABC02', sourceCreatedAt: '2026-06-01T00:00:00Z' });
    insert(seedDb, { sourceType: 'document', sourceId: '01K3F9X2VQ8N7M4TQXYZ8ABC03', sourceCreatedAt: '2026-03-01T00:00:00Z' });

    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.list('document').map((r) => r.sourceId)).toEqual([
        '01K3F9X2VQ8N7M4TQXYZ8ABC03',
        '01K3F9X2VQ8N7M4TQXYZ8ABC01',
      ]);
    } finally {
      reader.close();
    }
  });

  it('is an empty list, not an error, when nothing is published', () => {
    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.list('document')).toEqual([]);
    } finally {
      reader.close();
    }
  });
});

describe('findBySuffix', () => {
  it('finds a published row by the last 6 characters of its id', () => {
    insert(seedDb, { sourceType: 'document', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', sourceCreatedAt: '2026-01-01T00:00:00Z' });

    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.findBySuffix('document', 'abcdef')?.sourceId).toBe('01K3F9X2VQ8N7M4TQXYZABCDEF');
      expect(reader.findBySuffix('document', 'ABCDEF')?.sourceId).toBe('01K3F9X2VQ8N7M4TQXYZABCDEF');
    } finally {
      reader.close();
    }
  });

  it('never matches across source types', () => {
    insert(seedDb, { sourceType: 'entry', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', sourceCreatedAt: '2026-01-01T00:00:00Z' });

    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.findBySuffix('document', 'abcdef')).toBeNull();
      expect(reader.findBySuffix('entry', 'abcdef')?.sourceId).toBe('01K3F9X2VQ8N7M4TQXYZABCDEF');
    } finally {
      reader.close();
    }
  });

  it('returns null for a suffix that matches nothing', () => {
    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.findBySuffix('document', 'zzzzzz')).toBeNull();
    } finally {
      reader.close();
    }
  });

  it('returns null for a malformed suffix rather than querying with it', () => {
    insert(seedDb, { sourceType: 'document', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', sourceCreatedAt: '2026-01-01T00:00:00Z' });

    const reader = new PublishedIndexReader(dbPath);
    try {
      for (const bad of ['', 'abcd', 'abcdefg', "abc%de", "abc'de"]) {
        expect(reader.findBySuffix('document', bad)).toBeNull();
      }
    } finally {
      reader.close();
    }
  });
});

describe('getBySourceId', () => {
  it('finds a published row by its exact id', () => {
    insert(seedDb, { sourceType: 'document', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', sourceCreatedAt: '2026-01-01T00:00:00Z' });

    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.getBySourceId('document', '01K3F9X2VQ8N7M4TQXYZABCDEF')?.mirrorKey).toBe(
        'public/documents/01K3F9X2VQ8N7M4TQXYZABCDEF.json',
      );
    } finally {
      reader.close();
    }
  });

  it('never matches across source types', () => {
    insert(seedDb, { sourceType: 'entry', sourceId: '01K3F9X2VQ8N7M4TQXYZABCDEF', sourceCreatedAt: '2026-01-01T00:00:00Z' });

    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.getBySourceId('document', '01K3F9X2VQ8N7M4TQXYZABCDEF')).toBeNull();
    } finally {
      reader.close();
    }
  });

  it('returns null for an id that is not published', () => {
    const reader = new PublishedIndexReader(dbPath);
    try {
      expect(reader.getBySourceId('document', 'nope')).toBeNull();
    } finally {
      reader.close();
    }
  });
});

describe('opening the database', () => {
  it('refuses to create an index that does not exist', () => {
    expect(() => new PublishedIndexReader(join(dir, 'does-not-exist.db'))).toThrow();
  });
});
