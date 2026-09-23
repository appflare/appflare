import { Buffer } from "node:buffer";
import { type FetchLike, isAddressableObjectKey, type ScriptMetadata } from "@appflare/cf-api";
import {
  type AssetFile,
  assetFileSchema,
  type D1MigrationFile,
  d1MigrationFileSchema,
  type WorkerModule,
  workerModuleSchema,
} from "@appflare/schema";
import { z } from "zod";
import { releaseFetch } from "../../catalog/release-fetch";
import type { EmailRoutingInspection } from "../../installs/email-routing.server";
import { isNotFound, JobError } from "../errors";
import { artifactReader, fetchArtifactFile } from "../install/artifact";
import { APPLIED_MIGRATION_SQL, buildMigrationQuery } from "../install/d1-migrations";
import { uploadModule } from "../install/metadata";
import { assetContentType } from "../install/mime";
import { activeVersionId } from "../update/plan";
import {
  type EmailRoutingInspectInput,
  emailRoutingInspectInputSchema,
  runEmailRoutingInspection,
} from "./email-routing";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "./result";

/**
 * Job units: the pieces of a job that make many subrequests, each small
 * enough to finish within one Worker invocation's subrequest limit (50 on
 * Workers Free; every unit stays under 40). A job calls them through the
 * manager's own `SELF` service binding, so each call runs in a fresh
 * invocation with its own limit and costs the job one subrequest; a manager
 * without that binding runs them in the job's own invocation instead.
 *
 * A unit receives everything by value (the artifact URL, file offsets and
 * hashes, names, ids) and reads the API token and the GitHub token from the
 * Worker's own environment, never from its input.
 */

/** The manager's service binding to itself, through which jobs call the units. */
export const SELF_BINDING = "SELF";

/** The `WorkerEntrypoint` class that serves the units (src/jobs/units/entrypoint.ts). */
export const JOB_UNITS_ENTRYPOINT = "JobUnits";

/** Where the artifact zip lives: a catalog release, or the manager's own release feed. */
export const artifactHostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog") }),
  /** The release feed may need `GITHUB_TOKEN`, sent only to GitHub (see `releaseFetch`). */
  z.object({ kind: z.literal("release"), userAgent: z.string().min(1) }),
]);
export type ArtifactHost = z.infer<typeof artifactHostSchema>;

const artifactSchema = z.object({ zipUrl: z.string().min(1), host: artifactHostSchema });
const accountIdSchema = z.string().min(1);

export const assetPartInputSchema = z.object({
  accountId: accountIdSchema,
  artifact: artifactSchema,
  /** The upload session's JWT (bearer of the upload calls). */
  sessionJwt: z.string().min(1),
  /** The session asks for one request per file (`wrangler_single_asset_uploads`). */
  single: z.boolean(),
  files: z.array(assetFileSchema).min(1),
});
export type AssetPartInput = z.infer<typeof assetPartInputSchema>;
export interface AssetPartResult {
  /** The completion JWT once every file of the session is stored, else null. */
  jwt: string | null;
}

/** Script-upload metadata; its shape is checked by the Cloudflare API itself. */
const metadataSchema = z.custom<ScriptMetadata>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "metadata must be an object",
);

export const workerUploadInputSchema = z.object({
  accountId: accountIdSchema,
  artifact: artifactSchema,
  workerName: z.string().min(1),
  modules: z.array(workerModuleSchema).min(1),
  /**
   * Upload metadata. For an update it may carry the values of secrets the new
   * version introduces; it is never logged.
   */
  metadata: metadataSchema,
  /**
   * `script`: `PUT /workers/scripts/<name>`, which deploys at once (a new
   * install, or an update with Durable Object migrations). `version`: `POST
   * /workers/scripts/<name>/versions`, which serves no traffic yet.
   */
  target: z.enum(["script", "version"]),
});
export type WorkerUploadInput = z.infer<typeof workerUploadInputSchema>;
export interface WorkerUploadResult {
  /** The uploaded version; for `script`, null when Cloudflare did not report it. */
  versionId: string | null;
  /** The script id a `script` upload reports; null for `version`. */
  scriptId: string | null;
  /** Whether the new version has a preview URL (`version` only; null when unknown). */
  hasPreview: boolean | null;
  modules: number;
}

export const d1MigrationInputSchema = z.object({
  accountId: accountIdSchema,
  artifact: artifactSchema,
  databaseId: z.string().min(1),
  databaseName: z.string().min(1),
  file: d1MigrationFileSchema,
  /** A retried step first checks whether an earlier attempt already applied the file. */
  checkApplied: z.boolean(),
});
export type D1MigrationInput = z.infer<typeof d1MigrationInputSchema>;
export interface D1MigrationResult {
  /** False when an earlier attempt had already applied the file. */
  applied: boolean;
}

/** Objects one R2 page lists and deletes: one list call plus one delete per object. */
export const R2_PAGE_MAX_OBJECTS = 36;

export const r2PageInputSchema = z.object({
  accountId: accountIdSchema,
  bucket: z.string().min(1),
  /** The bucket's name as the job log shows it. */
  name: z.string().min(1),
  perPage: z.number().int().min(1).max(R2_PAGE_MAX_OBJECTS),
  /** The first key the previous page listed; seeing it again means a delete did not take. */
  previousFirst: z.string().nullable(),
});
export type R2PageInput = z.infer<typeof r2PageInputSchema>;
export interface R2PageResult {
  /** Whether more objects may remain. */
  more: boolean;
  /** The first key of this page, for the next page's check. */
  first: string | null;
  deleted: number;
}

/** The job units, as the `JobUnits` entrypoint serves them over RPC. */
export interface JobUnitsApi {
  /** Reads one part of an asset bucket from the artifact, checks every hash, uploads it. */
  uploadAssetPart(input: AssetPartInput): Promise<UnitResult<AssetPartResult>>;
  /** Reads every module from the artifact, checks every hash, uploads them in one request. */
  uploadWorker(input: WorkerUploadInput): Promise<UnitResult<WorkerUploadResult>>;
  /** Applies one D1 migration file the way wrangler does. */
  applyD1Migration(input: D1MigrationInput): Promise<UnitResult<D1MigrationResult>>;
  /** Lists one page of an R2 bucket's objects and deletes them. */
  emptyR2Page(input: R2PageInput): Promise<UnitResult<R2PageResult>>;
  /** Reads a zone's Email Routing state before an email app is installed there. */
  inspectEmailRouting(input: EmailRoutingInspectInput): Promise<UnitResult<EmailRoutingInspection>>;
}

/** The unit names, as RPC method names. */
export type JobUnitName = keyof JobUnitsApi;

/**
 * The units as served: every input arrives unchecked (over RPC it may come
 * from another version of the manager) and is validated first. Assignable to
 * {@link JobUnitsApi}.
 */
export type JobUnitsServer = {
  [K in JobUnitName]: (input: unknown) => ReturnType<JobUnitsApi[K]>;
};

/**
 * A unit's input as it arrived, validated: a unit may be served by another
 * version of the manager than the job's (a job keeps running while Appflare
 * updates itself), so a shape it does not know fails the step clearly.
 */
function parsed<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  unit: JobUnitName,
  run: (value: z.infer<S>) => Promise<UnitResult<T>>,
): Promise<UnitResult<T>> {
  const result = schema.safeParse(input);
  if (result.success) return run(result.data);
  return Promise.resolve({
    ok: false,
    failure: {
      kind: "final",
      message: `the running version of Appflare cannot run ${unit} with the input it was given (${z.prettifyError(result.error).replace(/\s+/g, " ")}); Appflare was probably updated while this job ran, so start it again`,
    },
    log: { lines: [], requests: [] },
    subrequests: 0,
  });
}

/** The fetch that reads the artifact: the release feed's wrapper for the manager's own releases. */
function artifactFetch(env: UnitEnv, fetch: FetchLike, host: ArtifactHost): FetchLike {
  return host.kind === "release"
    ? releaseFetch(fetch, { token: env.GITHUB_TOKEN, userAgent: host.userAgent })
    : fetch;
}

/** The units, run in this invocation with `env`'s secrets. */
export function createJobUnits(env: UnitEnv, deps: UnitDeps = {}): JobUnitsServer {
  return {
    uploadAssetPart: (input) =>
      parsed(assetPartInputSchema, input, "uploadAssetPart", (part) =>
        runUnit(env, deps, part.accountId, async ({ log, fetch, cf }) => {
          const api = cf();
          // One reader per call: it follows the release-asset redirect once and
          // reads adjacent files with one Range request.
          const reader = artifactReader(
            artifactFetch(env, fetch, part.artifact.host),
            part.artifact.zipUrl,
          );
          const files: AssetFile[] = part.files;
          const contents = await reader.read(files);
          const payload = files.map((file, i) => ({
            hash: file.hash,
            bytes: contents[i] ?? new Uint8Array(0),
            contentType: assetContentType(file.route),
          }));
          const bytes = payload.reduce((n, f) => n + f.bytes.byteLength, 0);
          let jwt: string | null = null;
          if (part.single) {
            for (const f of payload) {
              const res = await api.assets.uploadFile(part.sessionJwt, {
                hash: f.hash,
                body: f.bytes,
                contentType: f.contentType,
              });
              jwt = res.jwt ?? jwt;
            }
          } else {
            const res = await api.assets.uploadBucket(
              part.sessionJwt,
              payload.map((f) => ({
                hash: f.hash,
                base64: Buffer.from(f.bytes).toString("base64"),
                contentType: f.contentType,
              })),
            );
            jwt = res.jwt ?? null;
          }
          log.info(
            `Uploaded ${payload.length} asset file(s), ${bytes} bytes, read with ${reader.ranges} range request(s).`,
          );
          return { jwt };
        }),
      ),

    uploadWorker: (input) =>
      parsed(workerUploadInputSchema, input, "uploadWorker", (upload) =>
        runUnit(env, deps, upload.accountId, async ({ fetch, cf }) => {
          const reader = artifactReader(
            artifactFetch(env, fetch, upload.artifact.host),
            upload.artifact.zipUrl,
          );
          const refs: WorkerModule[] = upload.modules;
          const contents = await reader.read(refs);
          const modules = refs.map((module, i) =>
            uploadModule(module, contents[i] ?? new Uint8Array(0)),
          );
          const api = cf();
          if (upload.target === "version") {
            const result = await api.versions.uploadVersion(upload.workerName, {
              metadata: upload.metadata,
              modules,
            });
            return {
              versionId: result.id,
              scriptId: null,
              hasPreview: result.metadata?.has_preview ?? null,
              modules: modules.length,
            };
          }
          const result = await api.workers.uploadScript(upload.workerName, {
            metadata: upload.metadata,
            modules,
            excludeScript: true,
          });
          const versionId =
            hyphenateUuid(result.deployment_id) ??
            activeVersionId(await api.versions.listDeployments(upload.workerName));
          return {
            versionId,
            scriptId: result.id ?? upload.workerName,
            hasPreview: null,
            modules: modules.length,
          };
        }),
      ),

    applyD1Migration: (input) =>
      parsed(d1MigrationInputSchema, input, "applyD1Migration", (migration) =>
        runUnit(env, deps, migration.accountId, async ({ log, fetch, cf }) => {
          const api = cf();
          const file: D1MigrationFile = migration.file;
          // A retry must not re-run a file an earlier attempt already applied.
          if (migration.checkApplied) {
            const recorded = await api.d1.query(migration.databaseId, APPLIED_MIGRATION_SQL, [
              file.name,
            ]);
            if ((recorded[0]?.results.length ?? 0) > 0) {
              log.info(`${file.name} was applied by an earlier attempt.`);
              return { applied: false };
            }
          }
          const got = await fetchArtifactFile(
            artifactFetch(env, fetch, migration.artifact.host),
            migration.artifact.zipUrl,
            file,
          );
          const sql = new TextDecoder().decode(got.bytes);
          await api.d1.query(migration.databaseId, buildMigrationQuery(sql, file.name));
          log.info(`Applied ${file.name} to ${migration.databaseName}.`);
          return { applied: true };
        }),
      ),

    emptyR2Page: (input) =>
      parsed(r2PageInputSchema, input, "emptyR2Page", (page) =>
        runUnit(env, deps, page.accountId, async ({ log, cf }) => {
          const api = cf();
          let listed: Awaited<ReturnType<typeof api.r2.listObjects>>;
          try {
            listed = await api.r2.listObjects(page.bucket, { perPage: page.perPage });
          } catch (error) {
            if (!isNotFound(error)) throw error;
            log.info(`R2 bucket "${page.name}" was already gone.`);
            return { more: false, first: null, deleted: 0 };
          }
          const first = listed.items[0]?.key ?? null;
          if (first !== null && first === page.previousFirst) {
            throw new JobError(
              `the object "${first}" is still listed after it was deleted; retry the uninstall in a minute`,
            );
          }
          const unreachable = listed.items.find((o) => !isAddressableObjectKey(o.key));
          if (unreachable !== undefined) {
            throw new JobError(
              `the object "${unreachable.key}" cannot be deleted through the Cloudflare API because its key has a "." or ".." path segment; delete it with the S3 API, or retry the uninstall and keep this bucket`,
            );
          }
          for (const object of listed.items) {
            try {
              await api.r2.deleteObject(page.bucket, object.key);
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          }
          log.info(
            listed.items.length === 0
              ? `R2 bucket "${page.name}" is empty.`
              : `Deleted ${listed.items.length} object(s) from R2 bucket "${page.name}".`,
          );
          return {
            more: listed.items.length > 0 && listed.cursor !== null,
            first,
            deleted: listed.items.length,
          };
        }),
      ),

    inspectEmailRouting: (input) =>
      parsed(emailRoutingInspectInputSchema, input, "inspectEmailRouting", (request) =>
        runEmailRoutingInspection(env, deps, request),
      ),
  };
}

/** wrangler's `parseNonHyphenedUuid`: the upload's `deployment_id` may lack hyphens. */
export function hyphenateUuid(id: string | null | undefined): string | null {
  if (id == null || id.includes("-")) return id ?? null;
  if (id.length !== 32) return null;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
