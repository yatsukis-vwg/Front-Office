import type { TableName, Tables } from '../types.js';

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is_null' | 'not_null' | 'contains';

export interface Filter {
  field: string;
  op: FilterOperator;
  value?: unknown;
}

export interface QueryOptions {
  filters?: Filter[];
  orderBy?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

/**
 * The single persistence seam.
 *
 * Two implementations ship: `FileStore` (zero-setup demo, JSON on disk) and
 * `SupabaseStore` (Postgres). Repositories are written once against this
 * interface, so adding a third backend does not touch business logic.
 */
export interface Store {
  readonly driver: 'file' | 'supabase';
  insert<T extends TableName>(table: T, row: Tables[T]): Promise<Tables[T]>;
  insertMany<T extends TableName>(table: T, rows: Tables[T][]): Promise<Tables[T][]>;
  update<T extends TableName>(table: T, id: string, patch: Partial<Tables[T]>): Promise<Tables[T] | null>;
  delete<T extends TableName>(table: T, id: string): Promise<void>;
  deleteWhere<T extends TableName>(table: T, filters: Filter[]): Promise<number>;
  findById<T extends TableName>(table: T, id: string): Promise<Tables[T] | null>;
  findOne<T extends TableName>(table: T, options: QueryOptions): Promise<Tables[T] | null>;
  findMany<T extends TableName>(table: T, options?: QueryOptions): Promise<Tables[T][]>;
  count<T extends TableName>(table: T, filters?: Filter[]): Promise<number>;
  /**
   * Runs `fn` with exclusive access to `key`. Booking uses this to make the
   * "is the slot free?" check and the insert atomic. The Postgres schema also
   * carries an exclusion constraint, so a lost lock still cannot double-book.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function matchesFilter(row: Record<string, unknown>, filter: Filter): boolean {
  const actual = row[filter.field];
  switch (filter.op) {
    case 'eq':
      return actual === filter.value;
    case 'neq':
      return actual !== filter.value;
    case 'gt':
      return compare(actual, filter.value) > 0;
    case 'gte':
      return compare(actual, filter.value) >= 0;
    case 'lt':
      return compare(actual, filter.value) < 0;
    case 'lte':
      return compare(actual, filter.value) <= 0;
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(actual);
    case 'is_null':
      return actual === null || actual === undefined;
    case 'not_null':
      return actual !== null && actual !== undefined;
    case 'contains':
      return typeof actual === 'string' && typeof filter.value === 'string'
        ? actual.toLowerCase().includes(filter.value.toLowerCase())
        : false;
    default:
      return false;
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function applyQuery<T extends Record<string, unknown>>(rows: T[], options: QueryOptions = {}): T[] {
  let out = rows;
  if (options.filters?.length) {
    out = out.filter((row) => options.filters!.every((f) => matchesFilter(row, f)));
  }
  if (options.orderBy) {
    const { field, direction } = options.orderBy;
    out = [...out].sort((a, b) => {
      const result = compare(a[field], b[field]);
      return direction === 'desc' ? -result : result;
    });
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? out.length;
  return out.slice(offset, offset + limit);
}

export const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value });
export const gte = (field: string, value: unknown): Filter => ({ field, op: 'gte', value });
export const lte = (field: string, value: unknown): Filter => ({ field, op: 'lte', value });
export const gt = (field: string, value: unknown): Filter => ({ field, op: 'gt', value });
export const lt = (field: string, value: unknown): Filter => ({ field, op: 'lt', value });
export const isIn = (field: string, value: unknown[]): Filter => ({ field, op: 'in', value });
