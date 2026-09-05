import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TableName, Tables } from '../types.js';
import { applyQuery, matchesFilter, type Filter, type QueryOptions, type Store } from './store.js';

type Database = { [K in TableName]: Tables[K][] };

const EMPTY: Database = {
  clinics: [],
  patients: [],
  conversations: [],
  messages: [],
  appointments: [],
  reminders: [],
  escalations: [],
  audit_log: [],
  kb_overrides: [],
};

/**
 * JSON-file backed store for local development and the offline sales demo.
 *
 * It is deliberately simple: the whole database is held in memory and flushed
 * to disk after each mutation. That is fine for a demo dataset of a few
 * thousand rows and keeps `npm run demo` free of external dependencies. It is
 * rejected at start-up when NODE_ENV=production.
 */
export class FileStore implements Store {
  readonly driver = 'file' as const;

  private data: Database;
  private readonly path: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(path: string) {
    this.path = resolve(path);
    this.data = this.load();
  }

  private load(): Database {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Database>;
      return { ...structuredClone(EMPTY), ...parsed };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Debounced so a burst of writes costs one fsync, but never loses the last one. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, 25);
    this.flushTimer.unref?.();
  }

  flushSync(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 0), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private table<T extends TableName>(name: T): Tables[T][] {
    return this.data[name] as Tables[T][];
  }

  async insert<T extends TableName>(table: T, row: Tables[T]): Promise<Tables[T]> {
    this.table(table).push(row);
    this.scheduleFlush();
    return row;
  }

  async insertMany<T extends TableName>(table: T, rows: Tables[T][]): Promise<Tables[T][]> {
    this.table(table).push(...rows);
    this.scheduleFlush();
    return rows;
  }

  async update<T extends TableName>(table: T, id: string, patch: Partial<Tables[T]>): Promise<Tables[T] | null> {
    const rows = this.table(table);
    const index = rows.findIndex((r) => (r as { id: string }).id === id);
    if (index === -1) return null;
    const updated = { ...rows[index], ...patch } as Tables[T];
    rows[index] = updated;
    this.scheduleFlush();
    return updated;
  }

  async delete<T extends TableName>(table: T, id: string): Promise<void> {
    const rows = this.table(table);
    const index = rows.findIndex((r) => (r as { id: string }).id === id);
    if (index >= 0) rows.splice(index, 1);
    this.scheduleFlush();
  }

  async deleteWhere<T extends TableName>(table: T, filters: Filter[]): Promise<number> {
    const rows = this.table(table);
    const keep = rows.filter((row) => !filters.every((f) => matchesFilter(row as unknown as Record<string, unknown>, f)));
    const removed = rows.length - keep.length;
    this.data[table] = keep as Database[T];
    this.scheduleFlush();
    return removed;
  }

  async findById<T extends TableName>(table: T, id: string): Promise<Tables[T] | null> {
    return this.table(table).find((r) => (r as { id: string }).id === id) ?? null;
  }

  async findOne<T extends TableName>(table: T, options: QueryOptions): Promise<Tables[T] | null> {
    const rows = applyQuery(this.table(table) as unknown as Record<string, unknown>[], { ...options, limit: 1 });
    return (rows[0] as Tables[T] | undefined) ?? null;
  }

  async findMany<T extends TableName>(table: T, options: QueryOptions = {}): Promise<Tables[T][]> {
    return applyQuery(this.table(table) as unknown as Record<string, unknown>[], options) as unknown as Tables[T][];
  }

  async count<T extends TableName>(table: T, filters: Filter[] = []): Promise<number> {
    return applyQuery(this.table(table) as unknown as Record<string, unknown>[], { filters }).length;
  }

  /** Single-process serialisation: chains callers on a per-key promise. */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    // The queue tail must never reject, or every later caller inherits the failure.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
