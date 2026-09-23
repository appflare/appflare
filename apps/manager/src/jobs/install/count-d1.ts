/**
 * Wraps a D1 binding so every call that reaches D1 is counted. D1 calls are
 * subrequests too (developers.cloudflare.com/workers/platform/limits,
 * "Subrequests"), and the install job budgets them together with fetches.
 * A prepared statement counts once when it runs; a batch once.
 */
export function countD1(db: D1Database, count: () => void): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();

  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
          return (...args: unknown[]) => {
            count();
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    originals.set(proxy, stmt);
    return proxy;
  };

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query));
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          count();
          return target.batch(statements.map((s) => originals.get(s) ?? s));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "exec") {
        return (query: string) => {
          count();
          return target.exec(query);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}
