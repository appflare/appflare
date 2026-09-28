import {
  MAX_VECTORIZE_METADATA_INDEXES,
  managedR2LifecycleRuleId,
  mergeR2LifecycleRules,
  type R2LifecycleRule,
  undeclaredR2LifecycleRuleIds,
  type VectorizeMetadataIndex,
} from "@appflare/schema";
import { JobError, type JobSteps } from "../steps";
import type { ResourceBindingPlan } from "./bindings";
import { explainR2Refusal } from "./r2-enablement";

/**
 * Settings the artifact records for a Vectorize index or an R2 bucket that
 * wrangler's config cannot say: an index's metadata indexes and a bucket's
 * lifecycle rules. The install and update jobs set them on a resource they
 * create ({@link configureResourcePhase}); the update job also brings an
 * index or bucket the app already has up to what the new version declares
 * ({@link applyMetadataIndexesPhase} before its upload,
 * {@link applyLifecycleRulesPhase} once it serves). Nothing here deletes a metadata index
 * or removes a lifecycle rule, and every phase can run again without
 * changing anything a first run did.
 */

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function quotedList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  return quoted.length <= 1
    ? (quoted[0] ?? "")
    : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** Sets what the artifact records for a resource the job just created. */
export async function configureResourcePhase(
  steps: JobSteps,
  res: ResourceBindingPlan,
): Promise<void> {
  if (res.type === "vectorize") {
    // Before the app writes a vector, since vectors written earlier are never indexed.
    await createMetadataIndexesPhase(steps, res.name, res.metadataIndexes ?? []);
    return;
  }
  if (res.type === "r2_bucket" && res.lifecycle !== undefined && res.lifecycle.length > 0) {
    await setLifecycleRulesPhase(steps, res.name, res.lifecycle);
  }
}

/**
 * Gives an index an earlier version created the metadata indexes this
 * version declares and it lacks. The update runs it before the upload, so
 * the new version's first vector is indexed; a metadata index only helps
 * whatever version writes after it exists, so it is harmless if the update
 * fails later. One the index has is never deleted, even when this version no
 * longer declares it. `res.name` is the index's recorded name; anything but
 * a Vectorize index is left alone.
 */
export async function applyMetadataIndexesPhase(
  steps: JobSteps,
  res: ResourceBindingPlan,
): Promise<void> {
  if (res.type !== "vectorize") return;
  const declared = res.metadataIndexes ?? [];
  if (declared.length === 0) return;
  const missing = await steps.run(
    `list metadata indexes of Vectorize index ${res.name}`,
    async ({ log, cf }) => {
      const existing = await cf().vectorize.listMetadataIndexes(res.name);
      const lacking: VectorizeMetadataIndex[] = [];
      for (const index of declared) {
        const found = existing.find((m) => m.propertyName === index.propertyName);
        if (found === undefined) {
          lacking.push(index);
        } else if (found.indexType !== index.type) {
          log.warn(
            `Vectorize index "${res.name}" has a ${found.indexType} metadata index on "${index.propertyName}", and this version declares a ${index.type} one. Appflare never deletes a metadata index, so it stays as it is; queries that filter on "${index.propertyName}" as a ${index.type} may find nothing until it is deleted and created again.`,
          );
        }
      }
      if (lacking.length === 0) {
        log.info(
          `Vectorize index "${res.name}" already has the metadata indexes this version declares.`,
        );
        return { lacking };
      }
      if (existing.length + lacking.length > MAX_VECTORIZE_METADATA_INDEXES) {
        throw new JobError(
          `Vectorize index "${res.name}" has ${existing.length} metadata indexes and this version needs ${lacking.length} more (${quotedList(lacking.map((m) => m.propertyName))}), but Cloudflare allows ${MAX_VECTORIZE_METADATA_INDEXES} on an index. Delete the ones the app no longer filters on (wrangler vectorize delete-metadata-index), then update again`,
        );
      }
      log.info(
        `This version filters Vectorize index "${res.name}" on ${quotedList(lacking.map((m) => m.propertyName))}, which it has no metadata index for yet; creating ${lacking.length === 1 ? "it" : "them"}.`,
      );
      log.warn(
        `Vectors written to "${res.name}" before a metadata index exists are not indexed by it, so a query that filters on ${quotedList(lacking.map((m) => m.propertyName))} finds only vectors written from now on. The app has to write the older vectors again (an upsert of the same ids) for such queries to find them.`,
      );
      return { lacking };
    },
  );
  await createMetadataIndexesPhase(steps, res.name, missing.lacking);
}

/**
 * Merges this version's lifecycle rules into a bucket an earlier version
 * created. The update runs it only once the new version serves: a rule that
 * deletes objects must never reach a bucket the previous version still
 * serves from after a failed update. A rule Appflare set for an earlier
 * version that this one dropped stays, and the log says so. `res.name` is
 * the bucket's recorded name. A bucket whose app declares no rules now is
 * still read when `previouslyDeclared` says the installed version had some,
 * to name the ones left behind; anything but an R2 bucket is left alone.
 */
export async function applyLifecycleRulesPhase(
  steps: JobSteps,
  res: ResourceBindingPlan,
  previouslyDeclared = false,
): Promise<void> {
  if (res.type !== "r2_bucket") return;
  const declared = res.lifecycle ?? [];
  if (declared.length === 0 && !previouslyDeclared) return;
  await setLifecycleRulesPhase(steps, res.name, declared);
}

/** One step and one call per metadata index. */
async function createMetadataIndexesPhase(
  steps: JobSteps,
  indexName: string,
  indexes: readonly VectorizeMetadataIndex[],
): Promise<void> {
  for (const index of indexes) {
    await steps.run(
      `create metadata index ${index.propertyName} on Vectorize index ${indexName}`,
      async ({ log, cf, attempt }) => {
        const api = cf();
        // A retry may follow an attempt whose call Cloudflare took.
        if (attempt > 1) {
          const existing = await api.vectorize.listMetadataIndexes(indexName);
          if (existing.some((m) => m.propertyName === index.propertyName)) {
            log.info(
              `The metadata index on "${index.propertyName}" an earlier attempt created is there.`,
            );
            return {};
          }
        }
        await api.vectorize.createMetadataIndex(indexName, {
          propertyName: index.propertyName,
          indexType: index.type,
        });
        log.info(
          `Created a ${index.type} metadata index on "${index.propertyName}" for Vectorize index "${indexName}".`,
        );
        return {};
      },
    );
  }
}

/**
 * A value in a form two spellings of the same rule share: keys sorted, and
 * keys that say nothing left out (null, an empty list, an empty object, and
 * a condition's empty `prefix`, which is the same as none: every object).
 */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value !== "object" || value === null) return value;
  const entries: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (key === "conditions" && k === "prefix" && v === "") continue;
    const c = canonical(v, k);
    if (c === null || c === undefined) continue;
    if (Array.isArray(c) && c.length === 0) continue;
    if (typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 0) continue;
    entries.push([k, c]);
  }
  return Object.fromEntries(entries);
}

/**
 * Whether two lists of rules say the same, in the canonical form above and
 * in any order (a bucket's rules have no order that matters, and each has
 * its own id), so a list Cloudflare answers in its own spelling does not
 * read as a change.
 */
function sameRules(a: readonly unknown[], b: readonly unknown[]): boolean {
  const form = (rules: readonly unknown[]) =>
    rules
      .map((rule) => JSON.stringify(canonical(rule)))
      .sort()
      .join("\n");
  return form(a) === form(b);
}

/**
 * Reads a bucket's lifecycle rules and, when the declared ones are not all
 * there as declared, writes them back merged by id
 * ({@link mergeR2LifecycleRules}): only rules of Appflare's own ids
 * (`appflare:<id>`) are replaced, so Cloudflare's default rule for unfinished
 * multipart uploads and every rule added by hand stay. The write replaces
 * the whole list with the merge of what the read found, so a retry puts the
 * same rules; a later run finds them and writes nothing.
 */
async function setLifecycleRulesPhase(
  steps: JobSteps,
  bucket: string,
  declared: readonly R2LifecycleRule[],
): Promise<void> {
  const current = await steps.run(
    `read lifecycle rules of R2 bucket ${bucket}`,
    async ({ log, cf }) => {
      const rules = await explainR2Refusal(bucket, () => cf().r2.getLifecycleRules(bucket));
      const dropped = undeclaredR2LifecycleRuleIds(rules, declared);
      if (dropped.length > 0) {
        log.warn(
          `This version no longer declares the lifecycle ${dropped.length === 1 ? "rule" : "rules"} ${quotedList(dropped)} that Appflare set on R2 bucket "${bucket}" for an earlier version. Appflare never removes a rule, so ${dropped.length === 1 ? "it stays" : "they stay"} (as ${quotedList(dropped.map(managedR2LifecycleRuleId))}); delete ${dropped.length === 1 ? "it" : "them"} in the bucket's settings if the app no longer needs ${dropped.length === 1 ? "it" : "them"}.`,
        );
      }
      const unchanged = sameRules(rules, mergeR2LifecycleRules(rules, declared));
      if (unchanged && declared.length > 0) {
        log.info(
          `R2 bucket "${bucket}" already has the lifecycle ${declared.length === 1 ? "rule" : "rules"} ${quotedList(declared.map((r) => r.id))} as this version declares ${declared.length === 1 ? "it" : "them"}.`,
        );
      }
      return { rules, unchanged };
    },
  );
  if (current.unchanged) return;
  await steps.run(`set lifecycle rules of R2 bucket ${bucket}`, async ({ log, cf }) => {
    const rules = mergeR2LifecycleRules(current.rules, declared);
    await explainR2Refusal(bucket, () => cf().r2.putLifecycleRules(bucket, rules));
    const kept = rules.length - declared.length;
    log.info(
      `Set the lifecycle ${declared.length === 1 ? "rule" : "rules"} ${quotedList(declared.map((r) => r.id))} on R2 bucket "${bucket}" (shown there as ${quotedList(declared.map((r) => managedR2LifecycleRuleId(r.id)))})${kept > 0 ? `, keeping its ${kept === 1 ? "other rule" : `${kept} other rules`}` : ""}.`,
    );
    return {};
  });
}
