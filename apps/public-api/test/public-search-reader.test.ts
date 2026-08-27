import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublicSearchReader } from '../src/public-search-reader.js';

/**
 * Built against the exact schema `apps/api/src/index/public-search-index.ts`
 * migrates to — the same by-hand-duplication choice `index-reader.test.ts`
 * already made, for the same reason (this package has no dependency on
 * `apps/api`).
 */
function seedSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE public_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE public_chunks_fts USING fts5(text);
  `);
}

function insert(db: Database.Database, sourceType: string, sourceId: string, text: string): void {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO public_chunks (source_type, source_id, chunk_index, text) VALUES (?, ?, 0, ?)')
    .run(sourceType, sourceId, text);
  db.prepare('INSERT INTO public_chunks_fts (rowid, text) VALUES (?, ?)').run(lastInsertRowid, text);
}

let dir: string;
let dbPath: string;
let seedDb: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'journal-public-search-'));
  dbPath = join(dir, 'index.db');
  seedDb = new Database(dbPath);
  seedSchema(seedDb);
});

afterEach(async () => {
  seedDb.close();
  await rm(dir, { recursive: true, force: true });
});

describe('search', () => {
  it('finds a chunk by an exact word', () => {
    insert(seedDb, 'document', 'd1', 'notes about a lighthouse');

    const reader = new PublicSearchReader(dbPath);
    try {
      expect(reader.search('lighthouse', 10)).toEqual([
        { sourceType: 'document', sourceId: 'd1', text: 'notes about a lighthouse' },
      ]);
    } finally {
      reader.close();
    }
  });

  it('finds chunks across both source types', () => {
    insert(seedDb, 'document', 'd1', 'a lighthouse in the notes');
    insert(seedDb, 'entry', 'e1', 'a walk past the lighthouse');

    const reader = new PublicSearchReader(dbPath);
    try {
      expect(reader.search('lighthouse', 10).map((h) => h.sourceType).sort()).toEqual(['document', 'entry']);
    } finally {
      reader.close();
    }
  });

  it('is empty, not an error, when nothing matches', () => {
    const reader = new PublicSearchReader(dbPath);
    try {
      expect(reader.search('anything', 10)).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('is empty, not an error, for a whitespace-only query', () => {
    insert(seedDb, 'document', 'd1', 'some text');
    const reader = new PublicSearchReader(dbPath);
    try {
      expect(reader.search('   ', 10)).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('does not throw on FTS5 syntax characters — they are treated literally', () => {
    insert(seedDb, 'document', 'd1', 'cost is $10 (roughly)');
    const reader = new PublicSearchReader(dbPath);
    try {
      expect(() => reader.search('"unterminated', 10)).not.toThrow();
      expect(() => reader.search('foo AND (bar', 10)).not.toThrow();
    } finally {
      reader.close();
    }
  });

  it('respects the limit, capped at 50 regardless of what is requested', () => {
    for (let i = 0; i < 5; i += 1) insert(seedDb, 'document', `d${i}`, `apple chunk ${i}`);
    const reader = new PublicSearchReader(dbPath);
    try {
      expect(reader.search('apple', 2)).toHaveLength(2);
      expect(reader.search('apple', 1000)).toHaveLength(5);
    } finally {
      reader.close();
    }
  });
});

describe('opening the database', () => {
  it('refuses to create an index that does not exist', () => {
    expect(() => new PublicSearchReader(join(dir, 'does-not-exist.db'))).toThrow();
  });
});
