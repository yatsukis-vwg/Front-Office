import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { TableName, Tables } from '../types.js';
import type { Filter, QueryOptions, Store } from './store.js';

/**
 * PostgREST's builder is generically typed against a Database schema we do not
 * generate (the schema lives in supabase/migrations, not in TypeScript). We
 * therefore talk to it through a deliberately loose structural type and keep
 * type-safety at the repository boundary instead, where `Tables[T]` applies.
 */
type QueryResponse<T> = PromiseLike<{ data: T | null; error: { message: string } | null; count?: number | null }>;

type AnyQuery = {
  eq: (f: string, v: unknown) => AnyQuery;
  neq: (f: string, v: unknown) => AnyQuery;
  gt: (f: string, v: unknown) => AnyQuery;
  gte: (f: string, v: unknown) => AnyQuery;
  lt: (f: string, v: unknown) => AnyQuery;
  lte: (f: string, v: unknown) => AnyQuery;
  in: (f: string, v: readonly unknown[]) => AnyQuery;
  is: (f: string, v: null) => AnyQuery;
  not: (f: string, op: string, v: null) => AnyQuery;
  ilike: (f: string, v: string) => AnyQuery;
  order: (f: string, o: { ascending: boolean }) => AnyQuery;
  range: (from: number, to: number) => AnyQuery;
  limit: (n: number) => AnyQuery;
  maybeSingle: () => QueryResponse<unknown>;
  single: () => QueryResponse<unknown>;
  select: (columns?: string, options?: { count?: 'exact'; head?: boolean }) => AnyQuery;
  // PostgREST builders are thenable: awaiting one runs the query.
  then: QueryResponse<unknown[]>['then'];
};

type LooseTable = {
  insert: (rows: unknown) => AnyQuery;
  update: (patch: unknown) => AnyQuery;
  delete: () => AnyQuery;
  select: (columns?: string, options?: { count?: 'exact'; head?: boolean }) => AnyQuery;
};

function applyFilters(query: AnyQuery, filters: Filter[] = []): AnyQuery {
  let q = query;
  for (const filter of filters) {
    switch (filter.op) {
      case 'eq':
        q = q.eq(filter.field, filter.value);
        break;
      case 'neq':
        q = q.neq(filter.field, filter.value);
        break;
      case 'gt':
        q = q.gt(filter.field, filter.value);
        break;
      case 'gte':
        q = q.gte(filter.field, filter.value);
        break;
      case 'lt':
        q = q.lt(filter.field, filter.value);
        break;
      case 'lte':
        q = q.lte(filter.field, filter.value);
        break;
      case 'in':
        q = q.in(filter.field, (filter.value as unknown[]) ?? []);
        break;
      case 'is_null':
        q = q.is(filter.field, null);
        break;
      case 'not_null':
        q = q.not(filter.field, 'is', null);
        break;
      case 'contains':
        q = q.ilike(filter.field, `%${String(filter.value)}%`);
        break;
    }
  }
  return q;
}

/**
 * Postgres-backed store.
 *
 * Uses the service-role key, so RLS is bypassed by design — this process is
 * trusted infrastructure and enforces clinic isolation in the repository layer.
 * The RLS policies in the migration protect the anon/authenticated keys used by
 * anything else that talks to the database.
 */
export class SupabaseStore implements Store {
  readonly driver = 'supabase' as const;

  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private from(table: TableName): LooseTable {
    return this.client.from(table) as unknown as LooseTable;
  }

  async insert<T extends TableName>(table: T, row: Tables[T]): Promise<Tables[T]> {
    const { data, error } = await this.from(table).insert(row).select().single();
    if (error) throw new Error(`insert ${table} failed: ${error.message}`);
    return data as Tables[T];
  }

  async insertMany<T extends TableName>(table: T, rows: Tables[T][]): Promise<Tables[T][]> {
    if (rows.length === 0) return [];
    const out: Tables[T][] = [];
    // Chunked to stay comfortably inside PostgREST's request size limits.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { data, error } = await this.from(table).insert(chunk).select();
      if (error) throw new Error(`insertMany ${table} failed: ${error.message}`);
      out.push(...((data ?? []) as Tables[T][]));
    }
    return out;
  }

  async update<T extends TableName>(table: T, id: string, patch: Partial<Tables[T]>): Promise<Tables[T] | null> {
    const { data, error } = await this.from(table).update(patch).eq('id', id).select().maybeSingle();
    if (error) throw new Error(`update ${table} failed: ${error.message}`);
    return (data as Tables[T] | null) ?? null;
  }

  async delete<T extends TableName>(table: T, id: string): Promise<void> {
    const { error } = await this.from(table).delete().eq('id', id).select();
    if (error) throw new Error(`delete ${table} failed: ${error.message}`);
  }

  async deleteWhere<T extends TableName>(table: T, filters: Filter[]): Promise<number> {
    const { data, error } = await applyFilters(this.from(table).delete(), filters).select('id');
    if (error) throw new Error(`deleteWhere ${table} failed: ${error.message}`);
    return ((data ?? []) as unknown[]).length;
  }

  async findById<T extends TableName>(table: T, id: string): Promise<Tables[T] | null> {
    const { data, error } = await this.from(table).select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`findById ${table} failed: ${error.message}`);
    return (data as Tables[T] | null) ?? null;
  }

  async findOne<T extends TableName>(table: T, options: QueryOptions): Promise<Tables[T] | null> {
    const rows = await this.findMany(table, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async findMany<T extends TableName>(table: T, options: QueryOptions = {}): Promise<Tables[T][]> {
    let query = applyFilters(this.from(table).select('*'), options.filters);
    if (options.orderBy) {
      query = query.order(options.orderBy.field, { ascending: options.orderBy.direction === 'asc' });
    }
    if (options.limit !== undefined || options.offset !== undefined) {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 1000;
      query = query.range(offset, offset + limit - 1);
    }
    const { data, error } = await query;
    if (error) throw new Error(`findMany ${table} failed: ${error.message}`);
    return (data ?? []) as Tables[T][];
  }

  async count<T extends TableName>(table: T, filters: Filter[] = []): Promise<number> {
    const query = applyFilters(this.from(table).select('id', { count: 'exact', head: true }), filters);
    const { count, error } = await query;
    if (error) throw new Error(`count ${table} failed: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Postgres advisory lock, so booking is serialised across every API instance —
   * not just within one process. The `appointments` exclusion constraint is the
   * backstop if the RPC is unavailable.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = hashKey(key);
    const { error } = await this.client.rpc('fo_advisory_lock', { key: lockKey });
    if (error) {
      // Missing RPC (migration not applied) must not block booking: the
      // exclusion constraint still guarantees correctness.
      return fn();
    }
    try {
      return await fn();
    } finally {
      await this.client.rpc('fo_advisory_unlock', { key: lockKey });
    }
  }
}

/** 32-bit FNV-1a, folded into the signed range Postgres advisory locks accept. */
function hashKey(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}
