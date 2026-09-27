import {
  type CatalogD1Seed,
  type CatalogManifest,
  isSeedOnly,
  type PlaceholderValues,
  renderPlaceholders,
} from "@appflare/schema";
import { z } from "zod";
import type { VarBinding } from "../../installs/install-vars";
import { JobError, type JobSteps } from "../steps";
import { failureError, settleUnit } from "../units/result";
import type { D1Target } from "./phases";

/**
 * The install job's side of D1 seed statements (the catalog manifest's
 * `resources.d1[binding].seed`): which values a seed reads, and the step that
 * runs it through the `seedD1` unit. Only the install job seeds, once per
 * database; an update never does, even when a new version changes the seed.
 */

/**
 * The values of the seed-only secrets and vars the admin entered at install,
 * by name. They ride in the Workflow params alone (encrypted at rest, like
 * every secret value): never in `jobs.input_json`, the install's settings, or
 * the Worker's bindings.
 */
export const seedOnlyValuesSchema = z.object({
  secrets: z.record(z.string(), z.string()),
  vars: z.record(z.string(), z.string()),
});
export type SeedOnlyValues = z.infer<typeof seedOnlyValuesSchema>;

/** The names a seed reads: vars from `{ var }` params, secrets from `{ secret }` params and hashes. */
export function seedReads(seed: CatalogD1Seed): { vars: Set<string>; secrets: Set<string> } {
  const vars = new Set<string>();
  const secrets = new Set<string>();
  for (const hash of Object.values(seed.hashes ?? {})) secrets.add(hash.from);
  for (const statement of seed.statements) {
    for (const param of statement.params) {
      if ("var" in param) vars.add(param.var);
      else if ("secret" in param) secrets.add(param.secret);
    }
  }
  return { vars, secrets };
}

/**
 * What a seed's unit gets: the value of each var and secret it reads, and no
 * other. A seed-only var is what the admin entered, else its catalog default,
 * placeholders filled in; any other var is what the Worker gets
 * (`workerVars`). A secret is the value the job sets (derived ones included),
 * or a seed-only one's. A name without a value is left out, and the unit
 * says which one it lacked.
 */
export function seedValues(
  seed: CatalogD1Seed,
  input: {
    catalog: Pick<CatalogManifest, "vars" | "secrets">;
    /** The vars the Worker gets (`installVars`). */
    workerVars: readonly VarBinding[];
    /** The secret values the job sets. */
    secrets: Readonly<Record<string, string>>;
    seedOnly: SeedOnlyValues | undefined;
    placeholders: PlaceholderValues;
  },
): { vars: Record<string, string>; secrets: Record<string, string> } {
  const reads = seedReads(seed);
  const own = (record: Readonly<Record<string, string>> | undefined, name: string) =>
    record !== undefined && Object.hasOwn(record, name) ? record[name] : undefined;
  const vars: Record<string, string> = {};
  for (const name of reads.vars) {
    const declared = input.catalog.vars.find((v) => v.name === name);
    let value: string | undefined;
    if (declared !== undefined && isSeedOnly(declared)) {
      const entered = own(input.seedOnly?.vars, name);
      const text = entered !== undefined && entered.length > 0 ? entered : declared.default;
      value = text === undefined ? undefined : renderPlaceholders(text, input.placeholders);
    } else {
      const bound = input.workerVars.find((v) => v.name === name);
      value =
        bound === undefined
          ? undefined
          : bound.type === "json"
            ? JSON.stringify(bound.json)
            : bound.text;
    }
    if (value !== undefined && value.length > 0) vars[name] = value;
  }
  const secrets: Record<string, string> = {};
  for (const name of reads.secrets) {
    const value = own(input.seedOnly?.secrets, name) ?? own(input.secrets, name);
    if (value !== undefined && value.length > 0) secrets[name] = value;
  }
  return { vars, secrets };
}

/**
 * Step "D1 <binding>: seed": the binding's seed statements, in one `seedD1`
 * unit call. A retried step runs them again; each only adds a row that is
 * missing, so the row the first attempt added stays, and its hash matches the
 * same password. The step's output holds counts only.
 */
export async function seedD1Phase(
  steps: JobSteps,
  target: D1Target & { seed: CatalogD1Seed },
  values: { vars: Record<string, string>; secrets: Record<string, string> },
): Promise<void> {
  await steps.run(`D1 ${target.binding}: seed`, async ({ log }) => {
    const got = settleUnit(
      await steps.units.api.seedD1({
        accountId: steps.accountId(),
        databaseId: target.cfId,
        databaseName: target.name,
        binding: target.binding,
        seed: target.seed,
        values,
      }),
      log,
    );
    if (got.failed !== null) throw failureError(got.failed);
    if (got.statements !== target.seed.statements.length) {
      throw new JobError(
        `${target.name} ran ${got.statements} of ${target.seed.statements.length} seed statements`,
      );
    }
    const added = got.changes.reduce((n, c) => n + c, 0);
    log.info(
      `Seeded ${target.name}: ${got.statements} statement(s), ${added} row(s) added. Seed statements run only at install.`,
    );
    return { statements: got.statements, added };
  });
}
