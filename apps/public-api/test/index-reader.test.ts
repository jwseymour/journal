import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublicDocumentsReader } from '../src/index-reader.js';

/**
 * Built against the exact schema `apps/api/src/index/documents-index.ts`
 * migrates to — this is the one place this package has to agree with that
 * schema by hand, since it deliberately does not import that module
 * (`src/index-reader.ts`'s doc comment explains why).
 */
function seedSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      abs_path TEXT NOT NULL UNIQUE,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      created_epoch_ms INTEGER NOT NULL,
      created TEXT NOT NULL,
      updated_epoch_ms INTEGER NOT NULL,
      updated TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      public INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function insert(
  db: Database.Database,
  row: {
    id: string;
    title: string;
    createdEpochMs: number;
    excerpt?: string;
    public: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO documents (id, abs_path, rel_path, title, created_epoch_ms, created, updated_epoch_ms, updated, excerpt, content_hash, public)
     VALUES (@id, @absPath, @relPath, @title, @createdEpochMs, @created, @createdEpochMs, @created, @excerpt, 'hash', @public)`,
  ).run({
    id: row.id,
    absPath: `documents/${row.id}.md`,
    relPath: `documents/${row.id}.md`,
    title: row.title,
    createdEpochMs: row.createdEpochMs,
    created: new Date(row.createdEpochMs).toISOString(),
    excerpt: row.excerpt ?? 'Notes so far.',
    public: row.public ? 1 : 0,
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
  it('returns only public documents, newest-created-first', () => {
    insert(seedDb, { id: '01K3F9X2VQ8N7M4TQXYZ8ABC01', title: 'Old public', createdEpochMs: 1_000, public: true });
    insert(seedDb, { id: '01K3F9X2VQ8N7M4TQXYZ8ABC02', title: 'Private', createdEpochMs: 3_000, public: false });
    insert(seedDb, { id: '01K3F9X2VQ8N7M4TQXYZ8ABC03', title: 'New public', createdEpochMs: 2_000, public: true });

    const reader = new PublicDocumentsReader(dbPath);
    try {
      expect(reader.list().map((r) => r.title)).toEqual(['New public', 'Old public']);
    } finally {
      reader.close();
    }
  });

  it('is an empty list, not an error, when nothing is public', () => {
    insert(seedDb, { id: '01K3F9X2VQ8N7M4TQXYZ8ABC01', title: 'Private', createdEpochMs: 1_000, public: false });

    const reader = new PublicDocumentsReader(dbPath);
    try {
      expect(reader.list()).toEqual([]);
    } finally {
      reader.close();
    }
  });
});

describe('findBySuffix', () => {
  it('finds a public document by the last 6 characters of its id', () => {
    insert(seedDb, { id: '01K3F9X2VQ8N7M4TQXYZABCDEF', title: 'Findable', createdEpochMs: 1_000, public: true });

    const reader = new PublicDocumentsReader(dbPath);
    try {
      expect(reader.findBySuffix('abcdef')?.title).toBe('Findable');
      expect(reader.findBySuffix('ABCDEF')?.title).toBe('Findable');
    } finally {
      reader.close();
    }
  });

  it('returns null for a private document, even with the right suffix', () => {
    insert(seedDb, { id: '01K3F9X2VQ8N7M4TQXYZABCDEF', title: 'Private', createdEpochMs: 1_000, public: false });

    const reader = new PublicDocumentsReader(dbPath);
    try {
      expect(reader.findBySuffix('abcdef')).toBeNull();
    } finally {
      reader.close();
    }
  });

  it('returns null for a suffix that matches nothing', () => {
    const reader = new PublicDocumentsReader(dbPath);
    try {
      expect(reader.findBySuffix('zzzzzz')).toBeNull();
    } finally {
      reader.close();
    }
  });

  it('returns null for a malformed suffix rather than querying with it', () => {
    insert(seedDb, { id: '01K3F9X2VQ8N7M4TQXYZABCDEF', title: 'Findable', createdEpochMs: 1_000, public: true });

    const reader = new PublicDocumentsReader(dbPath);
    try {
      for (const bad of ['', 'abcd', 'abcdefg', "abc%de", "abc'de"]) {
        expect(reader.findBySuffix(bad)).toBeNull();
      }
    } finally {
      reader.close();
    }
  });
});

describe('opening the database', () => {
  it('refuses to create an index that does not exist', () => {
    expect(() => new PublicDocumentsReader(join(dir, 'does-not-exist.db'))).toThrow();
  });
});
