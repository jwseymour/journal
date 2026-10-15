import type { Layout, LayoutSummary, LayoutSurface, RawLayoutSpec } from '@journal/contract';
import { LayoutsIndex, type LayoutProjection } from '../index/layouts-index.js';
import { parseLayout } from '../layout/parse.js';
import { serializeLayout } from '../layout/serialize.js';
import { ulid } from '../record/id.js';
import { nowTimestamp } from '../record/time.js';

/**
 * The durable home of the user's layouts (`format.md` §8, `requirements.md`
 * §8) — authored, never regenerable from the journal files, so it lives
 * beside `derived/touched/` under the same storage root and is treated the
 * same way: the `.dsl` text is canonical, `LayoutsIndex` is a disposable
 * projection that `rebuild()` refills from the durable objects.
 *
 * Two objects per layout so the `.dsl` diffs cleanly in the scheduled git
 * mirror instead of sitting escaped inside a JSON string:
 *
 *   derived/layouts/<id>.dsl          canonical DSL text
 *   derived/layouts/<id>.meta.json    { id, surface, name, prose, isDefault, createdAt, updatedAt }
 *
 * The parsed spec is never stored — it is a pure grammar-level function of
 * the `.dsl` text (`layout/parse.ts`, no catalog), cached in the index and
 * reproduced by `rebuild()`.
 */

const PREFIX = 'derived/layouts/';
const dslKey = (id: string) => `${PREFIX}${id}.dsl`;
const metaKey = (id: string) => `${PREFIX}${id}.meta.json`;

/** The minimal blob surface the store needs — `put`/`get`/`delete` a single
 * object, and enumerate keys under a prefix for `rebuild()`. `fs` and S3
 * implementations live in `create-layout-store.ts`. */
export interface LayoutBlobStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
}

interface LayoutMeta {
  id: string;
  surface: LayoutSurface;
  name: string;
  prose: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The write seam `http/app.ts` depends on — a concrete class in production,
 * faked in tests with an in-memory `LayoutBlobStore` + a `:memory:` index. */
export interface LayoutStore {
  create(input: { surface: LayoutSurface; name: string; syntax: string; prose?: string | null }): Promise<Layout>;
  get(id: string): Promise<Layout | null>;
  list(surface: LayoutSurface): Promise<{ layouts: LayoutSummary[]; defaultId: string | null }>;
  /** `null` when `expectedUpdatedAt` no longer matches — the caller turns
   * that into `edit_conflict`. A missing `id` is the caller's to check
   * first (via `get`). */
  update(
    id: string,
    patch: { syntax?: string; prose?: string | null },
    expectedUpdatedAt: string,
  ): Promise<Layout | null>;
  setDefault(surface: LayoutSurface, id: string): Promise<string>;
  remove(id: string): Promise<void>;
  rebuild(): Promise<{ layoutCount: number }>;
}

export class DurableLayoutStore implements LayoutStore {
  readonly #blobs: LayoutBlobStore;
  readonly #index: LayoutsIndex;

  constructor(blobs: LayoutBlobStore, index: LayoutsIndex) {
    this.#blobs = blobs;
    this.#index = index;
  }

  async create(input: {
    surface: LayoutSurface;
    name: string;
    syntax: string;
    prose?: string | null;
  }): Promise<Layout> {
    await this.#ensureProjected();
    const now = nowTimestamp().canonical;
    const id = ulid(Date.now());

    const { spec } = parseLayout(input.syntax, input.surface);
    spec.name = input.name; // the request's name wins on create
    const canonical = serializeLayout(spec);

    // The first layout for a surface is its default — there must always be
    // one to fall back to before the built-in.
    const isDefault = this.#index.list(input.surface).length === 0;

    const meta: LayoutMeta = {
      id,
      surface: input.surface,
      name: input.name,
      prose: input.prose ?? null,
      isDefault,
      createdAt: now,
      updatedAt: now,
    };
    await this.#write(id, canonical, meta);
    this.#project(meta, canonical, spec);
    return this.#index.get(id)!;
  }

  async get(id: string): Promise<Layout | null> {
    await this.#ensureProjected();
    return this.#index.get(id);
  }

  async list(surface: LayoutSurface): Promise<{ layouts: LayoutSummary[]; defaultId: string | null }> {
    await this.#ensureProjected();
    const layouts = this.#index.list(surface);
    return { layouts, defaultId: layouts.find((l) => l.isDefault)?.id ?? null };
  }

  async update(
    id: string,
    patch: { syntax?: string; prose?: string | null },
    expectedUpdatedAt: string,
  ): Promise<Layout | null> {
    await this.#ensureProjected();
    const current = this.#index.get(id);
    if (!current) return null;
    if (current.updatedAt !== expectedUpdatedAt) return null;

    const nextSyntax = patch.syntax ?? current.syntax;
    const { spec } = parseLayout(nextSyntax, current.surface);
    const canonical = serializeLayout(spec);
    const now = nowTimestamp().canonical;

    const meta: LayoutMeta = {
      id,
      surface: current.surface,
      name: spec.name, // rename is by editing the `layout "…"` line
      prose: patch.prose !== undefined ? patch.prose : current.prose,
      isDefault: current.isDefault,
      createdAt: current.createdAt,
      updatedAt: now,
    };
    await this.#write(id, canonical, meta);
    this.#project(meta, canonical, spec);
    return this.#index.get(id)!;
  }

  async setDefault(surface: LayoutSurface, id: string): Promise<string> {
    await this.#ensureProjected();
    const target = this.#index.get(id);
    if (!target || target.surface !== surface) {
      throw new Error(`No layout ${id} on surface ${surface}`);
    }

    for (const summary of this.#index.list(surface)) {
      if (summary.isDefault === (summary.id === id)) continue;
      await this.#setDefaultFlag(summary.id, summary.id === id);
    }
    if (!target.isDefault) await this.#setDefaultFlag(id, true);
    return id;
  }

  async remove(id: string): Promise<void> {
    await this.#ensureProjected();
    const existing = this.#index.get(id);
    if (!existing) return;

    await this.#blobs.delete(dslKey(id));
    await this.#blobs.delete(metaKey(id));
    this.#index.remove(id);

    if (existing.isDefault) {
      // Promote the most-recently-updated survivor so the surface still has
      // a stored default; if none remains, render falls back to the built-in.
      const survivor = this.#index.list(existing.surface)[0];
      if (survivor) await this.#setDefaultFlag(survivor.id, true);
    }
  }

  async rebuild(): Promise<{ layoutCount: number }> {
    const keys = await this.#blobs.listKeys(PREFIX);
    const ids = new Set(
      keys.filter((key) => key.endsWith('.dsl')).map((key) => key.slice(PREFIX.length, -'.dsl'.length)),
    );

    const metas: LayoutMeta[] = [];
    const dsls = new Map<string, string>();
    for (const id of ids) {
      const [dsl, metaJson] = await Promise.all([this.#blobs.get(dslKey(id)), this.#blobs.get(metaKey(id))]);
      if (dsl === null || metaJson === null) continue; // half-written pair — skip
      metas.push(JSON.parse(metaJson) as LayoutMeta);
      dsls.set(id, dsl);
    }

    const surfaces = new Set(metas.map((meta) => meta.surface));
    for (const surface of surfaces) this.#index.clearSurface(surface);

    for (const meta of metas) {
      const dsl = dsls.get(meta.id)!;
      const { spec } = parseLayout(dsl, meta.surface);
      this.#project(meta, dsl, spec);
    }
    return { layoutCount: metas.length };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Self-heal a cold index on first read — boot never calls `rebuild()`
   * (same "never rebuild silently" posture as the index and touched mirror),
   * but the analysis page needs its default the moment it loads, so an empty
   * projection with durable objects present is reconciled here, once. */
  #projected = false;
  async #ensureProjected(): Promise<void> {
    if (this.#projected) return;
    this.#projected = true;
    if (this.#index.all().length > 0) return;
    const keys = await this.#blobs.listKeys(PREFIX);
    if (keys.length > 0) await this.rebuild();
  }

  async #write(id: string, canonical: string, meta: LayoutMeta): Promise<void> {
    await this.#blobs.put(dslKey(id), canonical);
    await this.#blobs.put(metaKey(id), `${JSON.stringify(meta, null, 2)}\n`);
  }

  #project(meta: LayoutMeta, syntax: string, spec: RawLayoutSpec): void {
    const projection: LayoutProjection = {
      id: meta.id,
      surface: meta.surface,
      name: meta.name,
      isDefault: meta.isDefault,
      prose: meta.prose,
      syntax,
      spec,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
    this.#index.put(projection);
  }

  async #setDefaultFlag(id: string, isDefault: boolean): Promise<void> {
    const layout = this.#index.get(id);
    if (!layout) return;
    const metaJson = await this.#blobs.get(metaKey(id));
    const meta = (metaJson ? (JSON.parse(metaJson) as LayoutMeta) : null) ?? {
      id,
      surface: layout.surface,
      name: layout.name,
      prose: layout.prose,
      isDefault: layout.isDefault,
      createdAt: layout.createdAt,
      updatedAt: layout.updatedAt,
    };
    meta.isDefault = isDefault;
    await this.#blobs.put(metaKey(id), `${JSON.stringify(meta, null, 2)}\n`);
    const { spec } = parseLayout(layout.syntax, layout.surface);
    this.#project(meta, layout.syntax, spec);
  }
}
