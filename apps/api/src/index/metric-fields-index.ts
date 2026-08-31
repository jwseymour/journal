import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * User-defined structured fields for temporal metrics — e.g. `exercise`
 * gaining `sport`, `distance_km`; `alcohol` gaining `units`. A sibling to
 * `CategoriesIndex`, mirroring its suggest/decide *shape* deliberately, but
 * kept as its own class and tables rather than folded into it: a field
 * definition's payload (type, unit, score range) is genuinely richer than
 * "a name, approved or not," the same reasoning this codebase already uses
 * to keep the extraction pipelines themselves separate rather than one
 * generic.
 *
 * Neither table here is touched by `MetricsIndex.clear()`/`reprocessAll()`
 * — like `categories`/`category_suggestions`, a field definition is a
 * decision a human (or an approved AI suggestion) made, not something a
 * reprocess-from-scratch regenerates; only the extracted `fields` values
 * themselves are the disposable cache.
 */

export type MetricFieldType = 'numeric' | 'enum' | 'text' | 'score';

export interface MetricFieldDefinition {
  id: string;
  metric: string;
  fieldKey: string;
  label: string;
  fieldType: MetricFieldType;
  /** Numeric fields only — descriptive metadata, never used for conversion. */
  unit: string | null;
  /** Score fields only — the scale's inclusive bounds. */
  scoreMin: number | null;
  scoreMax: number | null;
  /** Fed into the extraction prompt verbatim, so this is what actually
   * governs what the model tries to fill in. */
  description: string;
  createdAt: string;
}

export interface MetricFieldSuggestion {
  id: string;
  metric: string;
  fieldKey: string;
  label: string;
  fieldType: MetricFieldType;
  unit: string | null;
  scoreMin: number | null;
  scoreMax: number | null;
  description: string;
  /** One sentence: what in the entry prompted this. */
  reason: string;
  entryId: string;
  /** `'parked'` (`plan.md` M18) — set aside to reconsider later, neither
   * approved nor rejected. */
  status: 'pending' | 'approved' | 'rejected' | 'parked';
  suggestedAt: string;
  decidedAt: string | null;
}

export type DefineFieldInput = Omit<MetricFieldDefinition, 'id' | 'createdAt'> & { id: string; now: string };

/** Editing a field already defined — deliberately excludes `metric`,
 * `fieldKey`, and `fieldType`: those are the field's identity and the
 * shape of every value already stored under it, and changing them is a
 * "remove and redefine," not an edit. Everything else can be corrected
 * directly: get the label, description, unit, or score bounds wrong the
 * first time and it's a fix, not a delete-and-recreate. Only keys present
 * in the input change — read through `??` below, so `| undefined`
 * throughout matters, not just `?:` (see `UpdateMetricInput`'s own comment
 * on why a Zod-parsed body needs this under `exactOptionalPropertyTypes`). */
export interface UpdateFieldInput {
  label?: string | undefined;
  description?: string | undefined;
  unit?: string | null | undefined;
  scoreMin?: number | null | undefined;
  scoreMax?: number | null | undefined;
}
export type SuggestFieldInput = Omit<MetricFieldSuggestion, 'id' | 'status' | 'suggestedAt' | 'decidedAt'> & {
  id: string;
  now: string;
};

/** Same shape as `MetricsReader`/`CategoriesReader` — the seam `http/app.ts`
 * depends on. "Reader" by convention, not by content: like those two, it
 * mixes reads with the correction methods the HTTP layer needs (`define`,
 * `remove`, `decide`), not only lookups. */
export interface MetricFieldsReader {
  listForMetric(metric: string): MetricFieldDefinition[];
  listAll(): MetricFieldDefinition[];
  get(id: string): MetricFieldDefinition | null;
  define(input: DefineFieldInput): void;
  /** Edits label/description/unit/score bounds on a field already defined
   * — see `UpdateFieldInput`'s own comment for what's deliberately
   * excluded and why. Returns the updated definition, or `null` if `id`
   * doesn't exist. */
  update(id: string, input: UpdateFieldInput): MetricFieldDefinition | null;
  remove(id: string): void;
  listSuggestions(options?: { metric?: string; status?: MetricFieldSuggestion['status'] }): MetricFieldSuggestion[];
  /** `'parked'` (`plan.md` M18) — see `CategoriesReader.decide`'s comment. */
  decide(id: string, decision: 'approved' | 'rejected' | 'parked', now: string): void;
}

export class MetricFieldsIndex implements MetricFieldsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS metric_fields (
        id TEXT PRIMARY KEY,
        metric TEXT NOT NULL,
        field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        field_type TEXT NOT NULL,
        unit TEXT,
        score_min INTEGER,
        score_max INTEGER,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(metric, field_key)
      );

      CREATE TABLE IF NOT EXISTS metric_field_suggestions (
        id TEXT PRIMARY KEY,
        metric TEXT NOT NULL,
        field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        field_type TEXT NOT NULL,
        unit TEXT,
        score_min INTEGER,
        score_max INTEGER,
        description TEXT NOT NULL,
        reason TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS metric_field_suggestions_status ON metric_field_suggestions (metric, status);
    `);
  }

  /** The user defining a field directly — approved immediately, no
   * suggestion record at all, same second route `CategoriesIndex.approveDirectly`
   * implements for category names. */
  define(input: DefineFieldInput): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO metric_fields
           (id, metric, field_key, label, field_type, unit, score_min, score_max, description, created_at)
         VALUES (@id, @metric, @fieldKey, @label, @fieldType, @unit, @scoreMin, @scoreMax, @description, @now)`,
      )
      .run(input);
  }

  /** Edits an existing definition in place. A no-op returning `null` if
   * `id` doesn't exist — the caller decides whether that's an error. */
  update(id: string, input: UpdateFieldInput): MetricFieldDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: MetricFieldDefinition = {
      ...existing,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.scoreMin !== undefined ? { scoreMin: input.scoreMin } : {}),
      ...(input.scoreMax !== undefined ? { scoreMax: input.scoreMax } : {}),
    };
    this.#db
      .prepare('UPDATE metric_fields SET label = ?, description = ?, unit = ?, score_min = ?, score_max = ? WHERE id = ?')
      .run(next.label, next.description, next.unit, next.scoreMin, next.scoreMax, id);
    return next;
  }

  /** Discard a field definition (`requirements.md` §6.2 — mistakes must be
   * easy to fix). Existing records' `fields` JSON simply carries an orphaned
   * key going forward; the next `reprocess` writes fresh `fields` objects
   * containing only currently-defined keys. */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM metric_fields WHERE id = ?').run(id);
  }

  listForMetric(metric: string): MetricFieldDefinition[] {
    const rows = this.#db
      .prepare('SELECT * FROM metric_fields WHERE metric = ? ORDER BY field_key')
      .all(metric) as RawDefinition[];
    return rows.map(definitionFromRaw);
  }

  listAll(): MetricFieldDefinition[] {
    const rows = this.#db
      .prepare('SELECT * FROM metric_fields ORDER BY metric, field_key')
      .all() as RawDefinition[];
    return rows.map(definitionFromRaw);
  }

  /** Resolves one field by id — what `/metrics/fields/:id/values` needs to
   * know which `(metric, fieldKey)` an enum value is being approved for. */
  get(id: string): MetricFieldDefinition | null {
    const row = this.#db.prepare('SELECT * FROM metric_fields WHERE id = ?').get(id) as RawDefinition | undefined;
    return row ? definitionFromRaw(row) : null;
  }

  /**
   * The AI suggesting a field (`requirements.md` §5.3's first route,
   * extended from category names to fields) — never auto-approved. A no-op
   * if this exact `(metric, fieldKey)` is already defined, or already has a
   * pending suggestion, same double-check `CategoriesIndex.suggest` does.
   */
  suggest(input: SuggestFieldInput): void {
    const alreadyDefined = this.#db
      .prepare('SELECT 1 FROM metric_fields WHERE metric = ? AND field_key = ?')
      .get(input.metric, input.fieldKey);
    if (alreadyDefined) return;

    const alreadyPending = this.#db
      .prepare(
        "SELECT 1 FROM metric_field_suggestions WHERE metric = ? AND field_key = ? AND status = 'pending'",
      )
      .get(input.metric, input.fieldKey);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO metric_field_suggestions
           (id, metric, field_key, label, field_type, unit, score_min, score_max, description, reason, entry_id, status, suggested_at, decided_at)
         VALUES (@id, @metric, @fieldKey, @label, @fieldType, @unit, @scoreMin, @scoreMax, @description, @reason, @entryId, 'pending', @now, NULL)`,
      )
      .run(input);
  }

  listSuggestions(options: { metric?: string; status?: MetricFieldSuggestion['status'] } = {}): MetricFieldSuggestion[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.metric) {
      clauses.push('metric = ?');
      params.push(options.metric);
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM metric_field_suggestions ${where} ORDER BY suggested_at DESC`)
      .all(...params) as RawSuggestion[];
    return rows.map(suggestionFromRaw);
  }

  getSuggestion(id: string): MetricFieldSuggestion | null {
    const row = this.#db.prepare('SELECT * FROM metric_field_suggestions WHERE id = ?').get(id) as
      | RawSuggestion
      | undefined;
    return row ? suggestionFromRaw(row) : null;
  }

  /** Approving or rejecting a field suggestion. Approving also defines the
   * field in the same transaction — the two must never disagree. A no-op,
   * not an error, for a suggestion that is not pending. */
  decide(id: string, decision: 'approved' | 'rejected' | 'parked', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM metric_field_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawSuggestion | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE metric_field_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO metric_fields
               (id, metric, field_key, label, field_type, unit, score_min, score_max, description, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(row.id, row.metric, row.field_key, row.label, row.field_type, row.unit, row.score_min, row.score_max, row.description, now);
      }
    });
    apply();
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * A field usable with `MetricsIndex.sumByField` — numeric or score only,
 * text and enum excluded, since neither can be summed. Shared by `GET
 * /analysis/metrics/:metric/fields/:fieldKey` (`http/app.ts`) and the chat
 * feature's `sumMetricField` tool (`model/chat-orchestrator.ts`) so the two
 * can never validate this differently.
 */
export function resolveNumericField(
  metricFields: MetricFieldsReader,
  metric: string,
  fieldKey: string,
): MetricFieldDefinition | null {
  const field = metricFields.listForMetric(metric).find((candidate) => candidate.fieldKey === fieldKey);
  if (!field) return null;
  if (field.fieldType === 'text' || field.fieldType === 'enum') return null;
  return field;
}

interface RawDefinition {
  id: string;
  metric: string;
  field_key: string;
  label: string;
  field_type: MetricFieldType;
  unit: string | null;
  score_min: number | null;
  score_max: number | null;
  description: string;
  created_at: string;
}

function definitionFromRaw(row: RawDefinition): MetricFieldDefinition {
  return {
    id: row.id,
    metric: row.metric,
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    unit: row.unit,
    scoreMin: row.score_min,
    scoreMax: row.score_max,
    description: row.description,
    createdAt: row.created_at,
  };
}

interface RawSuggestion {
  id: string;
  metric: string;
  field_key: string;
  label: string;
  field_type: MetricFieldType;
  unit: string | null;
  score_min: number | null;
  score_max: number | null;
  description: string;
  reason: string;
  entry_id: string;
  status: MetricFieldSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function suggestionFromRaw(row: RawSuggestion): MetricFieldSuggestion {
  return {
    id: row.id,
    metric: row.metric,
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    unit: row.unit,
    scoreMin: row.score_min,
    scoreMax: row.score_max,
    description: row.description,
    reason: row.reason,
    entryId: row.entry_id,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}
