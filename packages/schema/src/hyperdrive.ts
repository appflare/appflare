import { z } from "zod";

/**
 * Databases an app reaches through Hyperdrive: the catalog manifest declares
 * each Hyperdrive binding with the database protocol it speaks, the install
 * form asks the admin for a connection string per binding, and the manager
 * turns that string into a Hyperdrive configuration of the install's own.
 * The connection string is a credential: it is never stored by the manager,
 * never logged, and never part of an error message. Client-safe.
 */

/** The database protocols Hyperdrive connects to. */
export const HYPERDRIVE_PROTOCOLS = ["postgres", "mysql"] as const;
export type HyperdriveProtocol = (typeof HYPERDRIVE_PROTOCOLS)[number];

/** Most Hyperdrive bindings one app may declare. */
export const MAX_HYPERDRIVE_BINDINGS = 8;

/** Longest connection string accepted, so a pasted blob cannot bloat a job's payload. */
export const MAX_CONNECTION_STRING_LENGTH = 4096;

/**
 * Longest value of each origin field Cloudflare accepts in a Hyperdrive
 * configuration (`hyperdrive_hyperdrive-database` in the API schema).
 */
const MAX_ORIGIN_FIELD_LENGTH = 2048;

/**
 * One Hyperdrive binding of the app's wrangler config, as the catalog
 * manifest declares it: `resources.hyperdrive[binding]`.
 */
export const catalogHyperdriveSchema = z.object({
  protocol: z
    .enum(HYPERDRIVE_PROTOCOLS)
    .describe("The database the app expects behind the binding: `postgres` or `mysql`."),
  label: z
    .string()
    .min(1)
    .describe('What the install form calls the database, for example "Main database".')
    .optional(),
  help: z
    .string()
    .min(1)
    .describe("A sentence under the connection string field, for example which schema it needs.")
    .optional(),
  /**
   * Hyperdrive's query caching for this binding's configuration. Omitted
   * keeps Cloudflare's default (on) when the configuration is created, and
   * an update leaves it as it is; `false` turns it off and `true` on, at
   * install and again on every update and settings change.
   */
  caching: z
    .boolean()
    .describe(
      "Whether Hyperdrive caches the results of read queries for this database. Omitted keeps " +
        "Cloudflare's default (on) when the configuration is created, and updates leave the " +
        "setting as it is. `false` turns caching off, for an app that must read its own writes " +
        "at once; `true` turns it on. Either value is applied at install and again on every " +
        'update and settings change, and needs `"hyperdrive-caching"` in `requires`.',
    )
    .optional(),
});
export type CatalogHyperdrive = z.infer<typeof catalogHyperdriveSchema>;

/** `resources.hyperdrive`: every Hyperdrive binding, by its name, at most {@link MAX_HYPERDRIVE_BINDINGS}. */
export const catalogHyperdriveBindingsSchema = z
  .record(z.string().min(1), catalogHyperdriveSchema)
  .refine((record) => Object.keys(record).length >= 1, "list at least one Hyperdrive binding")
  .refine(
    (record) => Object.keys(record).length <= MAX_HYPERDRIVE_BINDINGS,
    `an app declares at most ${MAX_HYPERDRIVE_BINDINGS} Hyperdrive bindings`,
  )
  .meta({ minProperties: 1, maxProperties: MAX_HYPERDRIVE_BINDINGS });
export type CatalogHyperdriveBindings = z.infer<typeof catalogHyperdriveBindingsSchema>;

/** One declared Hyperdrive binding with its name, as the install form and checks use it. */
export type HyperdriveDeclaration = CatalogHyperdrive & { binding: string };

/** The declared Hyperdrive bindings of `resources.hyperdrive`, each with its name, in order. */
export function hyperdriveDeclarations(
  record: Readonly<Record<string, CatalogHyperdrive>> | undefined,
): HyperdriveDeclaration[] {
  return Object.entries(record ?? {}).map(([binding, decl]) => ({ ...decl, binding }));
}

/** The URL schemes a connection string of each protocol may start with. */
const SCHEMES: Record<HyperdriveProtocol, readonly string[]> = {
  postgres: ["postgres", "postgresql"],
  mysql: ["mysql"],
};

/** The port each protocol listens on unless the connection string names another. */
export const DEFAULT_DATABASE_PORTS: Record<HyperdriveProtocol, number> = {
  postgres: 5432,
  mysql: 3306,
};

const PROTOCOL_NAMES: Record<HyperdriveProtocol, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
};

/** `PostgreSQL` or `MySQL`. */
export function databaseProtocolName(protocol: HyperdriveProtocol): string {
  return PROTOCOL_NAMES[protocol];
}

/** What a connection string of `protocol` looks like, for field descriptions. */
export function connectionStringExample(protocol: HyperdriveProtocol): string {
  const scheme = SCHEMES[protocol][0];
  return `${scheme}://user:password@db.example.com:${DEFAULT_DATABASE_PORTS[protocol]}/database`;
}

/** The field label of a declared binding: its label, else the protocol's connection string. */
export function hyperdriveFieldLabel(decl: HyperdriveDeclaration): string {
  return `${decl.label ?? `${databaseProtocolName(decl.protocol)} connection string`} (${decl.binding})`;
}

/**
 * A Hyperdrive origin as `POST /accounts/{id}/hyperdrive/configs` takes it
 * for a database reachable on the public internet
 * (`hyperdrive_hyperdrive-origin-full`, "Public Database": `scheme`, `host`,
 * `port`, `database`, `user`, `password`, all required).
 */
export interface HyperdriveOrigin {
  scheme: "postgres" | "postgresql" | "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type ConnectionStringResult =
  | { ok: true; origin: HyperdriveOrigin }
  | { ok: false; problem: string };

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/**
 * Reads a connection string for a database of `protocol`:
 * `postgres://user:password@host:port/database` (or `postgresql://`), or
 * `mysql://…` for MySQL. Host, user, password and database are required;
 * the port defaults to the protocol's. Query parameters such as `sslmode`
 * are ignored: Hyperdrive sets up TLS to the database itself.
 *
 * A problem is a sentence about which part is wrong; it never repeats any
 * part of the string, since the string holds a password.
 */
export function parseConnectionString(
  text: string,
  protocol: HyperdriveProtocol,
): ConnectionStringResult {
  const example = connectionStringExample(protocol);
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, problem: "Enter the connection string." };
  if (trimmed.length > MAX_CONNECTION_STRING_LENGTH) {
    return {
      ok: false,
      problem: `The connection string is longer than ${MAX_CONNECTION_STRING_LENGTH} characters.`,
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, problem: `This is not a connection string. Use the form ${example}.` };
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const schemes = SCHEMES[protocol];
  if (!schemes.includes(scheme)) {
    return {
      ok: false,
      problem: `This app needs a ${databaseProtocolName(protocol)} database: the connection string starts with ${schemes.map((s) => `${s}://`).join(" or ")}.`,
    };
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host.length === 0) {
    return { ok: false, problem: `The connection string has no host. Use the form ${example}.` };
  }
  const user = decoded(url.username);
  const password = decoded(url.password);
  const database = decoded(url.pathname.replace(/^\//, ""));
  if (user === null || password === null || database === null) {
    return {
      ok: false,
      problem: "The connection string has a malformed %-escape in its user, password or database.",
    };
  }
  if (user.length === 0) {
    return { ok: false, problem: `The connection string has no user. Use the form ${example}.` };
  }
  if (password.length === 0) {
    return {
      ok: false,
      problem: `The connection string has no password. Use the form ${example}.`,
    };
  }
  if (database.length === 0 || database.includes("/")) {
    return {
      ok: false,
      problem: `The connection string names no database after the host. Use the form ${example}.`,
    };
  }
  if ([host, user, password, database].some((part) => part.length > MAX_ORIGIN_FIELD_LENGTH)) {
    return {
      ok: false,
      problem: `A part of the connection string is longer than ${MAX_ORIGIN_FIELD_LENGTH} characters.`,
    };
  }
  const port = url.port === "" ? DEFAULT_DATABASE_PORTS[protocol] : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, problem: "The connection string's port is not between 1 and 65535." };
  }
  return {
    ok: true,
    origin: {
      scheme: scheme as HyperdriveOrigin["scheme"],
      host,
      port,
      database,
      user,
      password,
    },
  };
}

/**
 * Why a Worker's Hyperdrive bindings and the catalog manifest's
 * `resources.hyperdrive` disagree, one sentence each; empty when every
 * Hyperdrive binding is declared and every declaration is bound. The
 * manager asks for a connection string per declaration and binds one per
 * binding, so the two must match.
 */
export function hyperdriveDeclarationProblems(
  bindings: ReadonlyArray<{ type: string; name: string }>,
  declared: readonly Pick<HyperdriveDeclaration, "binding">[],
): string[] {
  const names = new Set(declared.map((d) => d.binding));
  const bound = new Set<string>();
  const problems: string[] = [];
  for (const binding of bindings) {
    if (binding.type !== "hyperdrive") continue;
    bound.add(binding.name);
    if (!names.has(binding.name)) {
      problems.push(
        `Hyperdrive binding ${binding.name} is not declared in the catalog manifest's resources.hyperdrive, so Appflare does not know which database it connects to.`,
      );
    }
  }
  for (const name of names) {
    if (!bound.has(name)) {
      problems.push(
        `The catalog manifest's resources.hyperdrive declares ${name}, but the Worker has no Hyperdrive binding by that name.`,
      );
    }
  }
  return problems;
}

/**
 * Why the connection strings entered for an app's declared Hyperdrive
 * bindings cannot be used, one sentence each; empty when every declared
 * binding has a valid one and nothing else was entered. `required` false
 * checks only the strings that were entered (a settings change replaces
 * some or none).
 */
export function connectionStringProblems(
  declared: readonly HyperdriveDeclaration[],
  entered: Readonly<Record<string, string>>,
  opts: { required: boolean } = { required: true },
): string[] {
  const byBinding = new Map(declared.map((d) => [d.binding, d]));
  const problems: string[] = [];
  for (const binding of Object.keys(entered)) {
    if (!byBinding.has(binding)) {
      problems.push(`${binding} is not a database connection of this app.`);
    }
  }
  for (const decl of declared) {
    const value = entered[decl.binding];
    if (value === undefined) {
      if (opts.required) problems.push(`${hyperdriveFieldLabel(decl)} is required.`);
      continue;
    }
    const parsed = parseConnectionString(value, decl.protocol);
    if (!parsed.ok) problems.push(`${hyperdriveFieldLabel(decl)}: ${parsed.problem}`);
  }
  return problems;
}
