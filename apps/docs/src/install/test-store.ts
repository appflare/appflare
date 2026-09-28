import type { KeyValueStore } from "./memory.ts";

/**
 * A `localStorage` stand-in for tests; `refuse` makes every call throw, as a
 * browser that blocks site data does.
 */
export function fakeStore(
  initial: Record<string, string> = {},
  refuse = false,
): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  const check = () => {
    if (refuse) throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    data,
    getItem(key) {
      check();
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      check();
      data.set(key, value);
    },
    removeItem(key) {
      check();
      data.delete(key);
    },
  };
}
