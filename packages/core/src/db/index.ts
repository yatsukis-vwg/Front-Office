import { getConfig } from '../config.js';
import { FileStore } from './file-store.js';
import { SupabaseStore } from './supabase-store.js';
import type { Store } from './store.js';

let store: Store | undefined;

export function getStore(): Store {
  if (store) return store;
  const config = getConfig();
  if (config.storeDriver === 'supabase') {
    store = new SupabaseStore(config.supabaseUrl!, config.supabaseServiceKey!);
  } else {
    store = new FileStore(config.fileStorePath);
  }
  return store;
}

/** Used by tests and the seed script to point at a scratch database. */
export function setStore(next: Store | undefined): void {
  store = next;
}

export * from './store.js';
export { FileStore } from './file-store.js';
export { SupabaseStore } from './supabase-store.js';
