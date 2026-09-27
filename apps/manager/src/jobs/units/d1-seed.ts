import {
  bcryptInputProblem,
  catalogD1SeedSchema,
  pbkdf2SeedHash,
  type SeedHash,
  type SeedHashValues,
  seedBcryptCost,
  seedStatementParams,
  seedStatementProblems,
} from "@appflare/schema";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { JobError } from "../errors";
import {
  describeFailure,
  runUnit,
  type UnitDeps,
  type UnitEnv,
  type UnitFailure,
  UnitItemError,
  type UnitResult,
} from "./result";

/**
 * The job unit `seedD1`: one D1 binding's seed statements
 * (`resources.d1[binding].seed`), run once by the install job. It derives
 * the seed's hashes, then sends each statement as its own D1 `/query` call
 * with the values as `params`, so no value is ever part of the SQL. The
 * statements are checked again here (one guarded INSERT, one param per `?`)
 * whatever the caller checked, since the input crosses an RPC call.
 *
 * Nothing it handles is logged or returned: the log names statements by
 * number with the rows each added, a failure carries D1's message and never
 * a param, and the hashes live only in this invocation's memory and the
 * app's table.
 */

export const d1SeedInputSchema = z.object({
  accountId: z.string().min(1),
  databaseId: z.string().min(1),
  databaseName: z.string().min(1),
  /** The binding, for the log. */
  binding: z.string().min(1),
  seed: catalogD1SeedSchema,
  /**
   * The values the seed's params and hashes read, by name: only those it
   * names. Seed-only secrets and vars live nowhere else but the job's params.
   */
  values: z.object({
    vars: z.record(z.string(), z.string()),
    secrets: z.record(z.string(), z.string()),
  }),
});
export type D1SeedInput = z.infer<typeof d1SeedInputSchema>;

export interface D1SeedResult {
  /** Statements run. */
  statements: number;
  /** Rows each statement added (0 when the row was already there), in order. */
  changes: number[];
  /** Why the statement after the ones run failed, naming it, or null. */
  failed: UnitFailure | null;
}

/** `hash`'s value (and salt) from `value`, computed in this invocation. */
export async function deriveSeedHash(
  id: string,
  hash: SeedHash,
  value: string,
): Promise<{ hash: string; salt?: string }> {
  switch (hash.method) {
    case "pbkdf2-sha256":
      return pbkdf2SeedHash(hash, value);
    case "bcrypt": {
      const problem = bcryptInputProblem(`The source of the hash "${id}" (${hash.from})`, value);
      if (problem !== null) throw new JobError(problem);
      // Synchronous: the async form only splits the same work across timers.
      return { hash: bcrypt.hashSync(value, seedBcryptCost(hash)) };
    }
  }
}

/** Every hash of the seed, each computed once for this run. */
async function deriveHashes(input: D1SeedInput): Promise<SeedHashValues> {
  const out: SeedHashValues = {};
  for (const [id, hash] of Object.entries(input.seed.hashes ?? {})) {
    const value = Object.hasOwn(input.values.secrets, hash.from)
      ? input.values.secrets[hash.from]
      : undefined;
    if (value === undefined || value.length === 0) {
      throw new JobError(`the seed's hash "${id}" is of ${hash.from}, which has no value`);
    }
    out[id] = await deriveSeedHash(id, hash, value);
  }
  return out;
}

/** The number of rows a `/query` result says a statement changed. */
function changesOf(meta: Record<string, unknown> | undefined): number {
  const changes = meta?.changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}

/** The unit body. */
export function runD1Seed(
  env: UnitEnv,
  deps: UnitDeps,
  input: D1SeedInput,
): Promise<UnitResult<D1SeedResult>> {
  return runUnit(env, deps, input.accountId, async ({ log, cf }) => {
    const { statements } = input.seed;
    // The schema checked each statement as it parsed the input; say so
    // again in plain code, so no path runs a statement the guard refuses.
    statements.forEach((statement, i) => {
      const problems = seedStatementProblems(statement.sql, statement.params.length);
      if (problems.length > 0) {
        throw new JobError(`seed statement ${i + 1} cannot run: ${problems.join("; ")}`);
      }
    });
    const hashes = await deriveHashes(input);
    const api = cf();
    const changes: number[] = [];
    let failed: UnitFailure | null = null;
    for (const [i, statement] of statements.entries()) {
      const subject = `seed statement ${i + 1} of ${statements.length}`;
      let params: string[];
      try {
        params = seedStatementParams(statement, {
          vars: input.values.vars,
          secrets: input.values.secrets,
          hashes,
        });
      } catch (error) {
        // A value the install never had: no retry brings it.
        throw new JobError(`${subject}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const result = await api.d1.query(input.databaseId, statement.sql, params);
        const added = changesOf(result[0]?.meta);
        changes.push(added);
        log.info(
          added === 0
            ? `Ran ${subject} on ${input.databaseName}: the row was already there.`
            : `Ran ${subject} on ${input.databaseName}: ${added} row(s) added.`,
        );
      } catch (error) {
        failed = describeFailure(new UnitItemError(subject, error));
        break;
      }
    }
    return { statements: changes.length, changes, failed };
  });
}
