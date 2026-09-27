import { useSyncExternalStore } from "react";

/**
 * A small choice remembered per browser in localStorage, such as whether the
 * sidebar is folded. Other tabs follow through the `storage` event. Storage
 * that is blocked or full only means the choice is not remembered: it still
 * holds for this page.
 */

export type ChoiceStorage = Pick<Storage, "getItem" | "setItem">;

export interface LocalChoice<T extends string> {
  /** The stored choice, or the default when nothing (or something unknown) is stored. */
  read(storage: ChoiceStorage | undefined): T;
  /** Stores the choice; a refusal is ignored. */
  write(storage: ChoiceStorage | undefined, value: T): void;
  /** The remembered choice and a setter. Before hydration (and on the server) it is the default. */
  useChoice(): [T, (value: T) => void];
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function localChoice<T extends string>(
  key: string,
  /** The choice a stored value stands for; anything unknown is the default. */
  parse: (value: string | null | undefined) => T,
): LocalChoice<T> {
  const initial = parse(null);
  const listeners = new Set<() => void>();
  /** Last value set in this page, for browsers whose storage refuses writes. */
  let fallback: T | null = null;

  function read(storage: ChoiceStorage | undefined): T {
    try {
      return parse(storage?.getItem(key));
    } catch {
      return initial;
    }
  }

  function write(storage: ChoiceStorage | undefined, value: T): void {
    try {
      storage?.setItem(key, value);
    } catch {
      // Not remembered; the choice still holds for this page.
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  function snapshot(): T {
    return fallback ?? read(browserStorage());
  }

  function set(value: T): void {
    const storage = browserStorage();
    write(storage, value);
    fallback = read(storage) === value ? null : value;
    for (const listener of listeners) listener();
  }

  function useChoice(): [T, (value: T) => void] {
    // `set` is one function per choice, so the setter never changes identity.
    return [useSyncExternalStore(subscribe, snapshot, () => initial), set];
  }

  return { read, write, useChoice };
}
