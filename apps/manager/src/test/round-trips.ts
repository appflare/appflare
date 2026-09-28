import { env } from "cloudflare:workers";

/**
 * Test-only: counts what a piece of server code waits on (D1 statements, KV
 * operations, Workflow lookups, outbound fetches) and how many of those waits
 * are chained one after another, by patching the bindings every module reads
 * through `cloudflare:workers`.
 *
 * Operations are held and let through in rounds, so the count does not
 * depend on timing: every operation started is held until the code has gone
 * quiet (nothing new started for several turns of the event loop and no
 * released operation still running), then all held operations run together
 * as one round. Operations started together (a `Promise.all`) share a
 * round; one started only after another finished lands in a later round. An
 * operation's depth is its round's number; the last round's number is the
 * number of sequential round trips on the critical path ("waves").
 */

export type OpKind = "d1" | "d1-batch" | "kv" | "workflow" | "fetch";

export interface ProbedOp {
  kind: OpKind;
  label: string;
  depth: number;
  /** Statements the operation ran: 1, or the size of a D1 batch. */
  statements: number;
}

export interface RoundTrips {
  ops: ProbedOp[];
  /** D1 statements, a batch counting each of its statements. */
  d1Statements(): number;
  /** D1 round trips: a batch is one. */
  d1RoundTrips(): number;
  kvOps(): number;
  /** Sequential waits on the critical path, over every kind. */
  waves(): number;
  /** Forgets what was recorded (the patches stay). */
  clear(): void;
  /** Removes every patch. */
  restore(): void;
}

/**
 * Quiet turns of the event loop before a round is let through: enough for
 * work between two operations that is itself asynchronous but not probed
 * (Web Crypto, for a signed cookie) to start what it leads to.
 */
const QUIET_TURNS = 5;

interface Held {
  record: ProbedOp;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** Replaces `obj[name]` until `undo` runs, whether it is an own or an inherited property. */
function patch<T extends object>(
  obj: T,
  name: string,
  make: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
  undo: Array<() => void>,
): void {
  const record = obj as Record<string, unknown>;
  const own = Object.getOwnPropertyDescriptor(obj, name);
  const original = (record[name] as (...args: unknown[]) => unknown).bind(obj);
  Object.defineProperty(obj, name, { value: make(original), configurable: true, writable: true });
  undo.push(() => {
    if (own === undefined) delete record[name];
    else Object.defineProperty(obj, name, own);
  });
}

/**
 * Patches `env.DB`, `env.KV`, `env.JOBS` and `globalThis.fetch`. Call
 * `restore()` when done (an `afterEach` is the usual place).
 */
export function probeRoundTrips(): RoundTrips {
  const ops: ProbedOp[] = [];
  const undo: Array<() => void> = [];
  let round = 0;
  let held: Held[] = [];
  let running = 0;
  let quiet = 0;
  let seen = 0;
  let scheduled = false;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(tick, 0);
  };

  function tick() {
    scheduled = false;
    if (running > 0 || held.length === 0) return;
    if (held.length !== seen) {
      seen = held.length;
      quiet = 0;
      schedule();
      return;
    }
    quiet += 1;
    if (quiet < QUIET_TURNS) {
      schedule();
      return;
    }
    round += 1;
    const batch = held;
    held = [];
    seen = 0;
    quiet = 0;
    running = batch.length;
    for (const h of batch) {
      h.record.depth = round;
      ops.push(h.record);
      h.run()
        .then(h.resolve, h.reject)
        .finally(() => {
          running -= 1;
          if (running === 0) schedule();
        });
    }
  }

  function op<T>(
    kind: OpKind,
    label: string,
    statements: number,
    run: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      held.push({
        record: { kind, label, depth: 0, statements },
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      schedule();
    });
  }

  // D1: statements are wrapped so that running one is counted; a batch gets
  // the real statements back.
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrapStatement(inner.bind(...values), sql),
      first: (column?: string) =>
        op("d1", sql, 1, () => (column === undefined ? inner.first() : inner.first(column))),
      run: () => op("d1", sql, 1, () => inner.run()),
      all: () => op("d1", sql, 1, () => inner.all()),
      raw: (options?: { columnNames?: boolean }) =>
        op("d1", sql, 1, () =>
          options?.columnNames === true ? inner.raw({ columnNames: true }) : inner.raw(),
        ),
    } as unknown as D1PreparedStatement;
    unwrap.set(wrapped, inner);
    return wrapped;
  };
  patch(
    env.DB,
    "prepare",
    (original) => (sql) => wrapStatement(original(sql) as D1PreparedStatement, String(sql)),
    undo,
  );
  patch(
    env.DB,
    "batch",
    (original) => (statements) => {
      const list = statements as D1PreparedStatement[];
      const real = list.map((s) => unwrap.get(s) ?? s);
      return op(
        "d1-batch",
        `batch of ${real.length}`,
        real.length,
        () => original(real) as Promise<unknown>,
      );
    },
    undo,
  );
  patch(
    env.DB,
    "exec",
    (original) => (sql) => op("d1", String(sql), 1, () => original(sql) as Promise<unknown>),
    undo,
  );

  for (const name of ["get", "getWithMetadata", "put", "list", "delete"]) {
    patch(
      env.KV,
      name,
      (original) =>
        (...args) =>
          op(
            "kv",
            `${name} ${String(args[0] && typeof args[0] === "object" ? "list" : args[0])}`,
            1,
            () => original(...args) as Promise<unknown>,
          ),
      undo,
    );
  }

  patch(
    env.JOBS,
    "get",
    (original) => (id) =>
      op("workflow", `get ${String(id)}`, 1, async () => {
        const instance = (await original(id)) as { status(): Promise<unknown> };
        return {
          ...instance,
          status: () => op("workflow", `status ${String(id)}`, 1, () => instance.status()),
        };
      }),
    undo,
  );

  patch(
    globalThis,
    "fetch",
    (original) => (input, init) =>
      op(
        "fetch",
        String(input instanceof Request ? input.url : input),
        1,
        () => original(input, init) as Promise<unknown>,
      ),
    undo,
  );

  return {
    ops,
    d1Statements: () =>
      ops
        .filter((o) => o.kind === "d1" || o.kind === "d1-batch")
        .reduce((n, o) => n + o.statements, 0),
    d1RoundTrips: () => ops.filter((o) => o.kind === "d1" || o.kind === "d1-batch").length,
    kvOps: () => ops.filter((o) => o.kind === "kv").length,
    waves: () => ops.reduce((n, o) => Math.max(n, o.depth), 0),
    clear() {
      ops.length = 0;
      round = 0;
    },
    restore() {
      for (const u of undo.reverse()) u();
      undo.length = 0;
    },
  };
}
