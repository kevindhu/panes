import { useCallback, useSyncExternalStore } from "react";

// View state outlives virtual rows. Only small UI values belong here, never payloads.
const values = new Map<string, boolean | number>();
const listeners = new Map<string, Set<() => void>>();
const LIMIT = 20_000;
let revision = 0;
const allListeners = new Set<() => void>();
export function readTranscriptDisclosure(key: string, initial: boolean) { return (values.get(key) as boolean | undefined) ?? initial; }
export function useTranscriptViewRevision() {
  return useSyncExternalStore(listener => {
    allListeners.add(listener);
    return () => { allListeners.delete(listener); };
  }, () => revision, () => revision);
}

function useTranscriptValue<T extends boolean | number>(key: string, initial: T) {
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(key);
    };
  }, [key]);
  const read = useCallback(() => (values.get(key) as T | undefined) ?? initial, [key, initial]);
  const value = useSyncExternalStore(subscribe, read, read);
  const update = useCallback((next: T | ((previous: T) => T)) => {
    const result = typeof next === "function" ? next((values.get(key) as T | undefined) ?? initial) : next;
    if (result === ((values.get(key) as T | undefined) ?? initial)) return;
    values.delete(key);
    values.set(key, result);
    revision++;
    if (key.includes(":group:")) for (const listener of allListeners) listener();
    for (const listener of listeners.get(key) ?? []) listener();
    if (values.size > LIMIT) {
      for (const oldest of values.keys()) {
        if (!listeners.has(oldest)) values.delete(oldest);
        if (values.size <= LIMIT) break;
      }
    }
  }, [key, initial]);
  return [value, update] as const;
}

export function resetTranscriptViewStateForTests() {
  values.clear();
  revision++;
  for (const listener of allListeners) listener();
  for (const set of listeners.values()) for (const listener of set) listener();
}

export const useTranscriptDisclosure = (key: string, initial: boolean) => useTranscriptValue(key, initial);
export const useTranscriptPage = (key: string) => useTranscriptValue<number>(key, 0);
