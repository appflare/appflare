import { NonRetryableError } from "cloudflare:workflows";
import {
  buildCommandChoiceSchema,
  buildInstallIdSchema,
  buildVersionSchema,
  catalogManifestSchema,
  githubRepositorySchema,
  githubTokenIdSchema,
  githubTokenSecretName,
  gitRefSchema,
  gitShaSchema,
  type RepositoryBuildRequest,
  repositoryBuildRequestSchema,
  SANDBOX_PROTOCOL_VERSION,
  sandboxInstanceTypeSchema,
  sandboxObjectUrl,
} from "@appflare/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { jobs, SOURCE_BUILD_PURPOSES, source_builds } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { addedJustNow, justAddedMessage, readGithubToken } from "../github/tokens.server";
import {
  buildsFromRepository,
  configPatchRefusal,
  installDirsRefusal,
  parseRepositoryBuildOutcome,
  SandboxProtocolError,
  sandboxBinding,
  sandboxFetch,
  sandboxInfo,
  usesGithubTokens,
} from "../sandbox/binding";
import { UPDATE_SANDBOX_HINT } from "../sandbox/connect-copy";
import { verifySourceBuildManifest } from "../sandbox/verify";
import { fetchWhole } from "./install/artifact";
import { BUILD_LOG_LINES, SANDBOX_BUILD_STEP } from "./install/artifact-source";
import type { JobContext } from "./run-job";
import { awaitSandboxEnabledPhase, sandboxEnableJobField } from "./sandbox-enable-wait";
import { awaitSandboxSettledPhase } from "./sandbox-settle";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";

/**
 * The `source_build` job: builds a GitHub repository (or a catalog
 * app at another commit) in the sandbox Worker for an admin to review, and
 * records the result in `source_builds`. Nothing is deployed: the review
 * page shows what the build found, and installing or updating from it is an
 * `install` or `update` job of its own, which reads this build as it is.
 *
 * 1. Check the sandbox Worker: connected, and new enough to build from a
 *    repository (`info().features`).
 * 2. Wait for it to settle (a secret change may still be rolling out).
 * 3. Build in the sandbox Worker (one RPC call for the whole build; a build
 *    that could not start or was cut off runs once more).
 * 4. Read the built `manifest.json` through the binding and verify it: the
 *    digest the build reported, unsigned, the repository, commit and version
 *    that were built, under this install's prefix. Record it.
 */

/** The run id a build's log lives under (`builds/<installId>/<runId>/log.txt`). */
export function sourceBuildRunId(jobId: string): string {
  return `src-${jobId}`;
}

export const sourceBuildJobParams = z.object({
  kind: z.literal("source_build"),
  jobId: z.string().min(1).max(64),
  /** The install the build is for: a new install's id, or the install being updated. */
  installId: buildInstallIdSchema,
  purpose: z.enum(SOURCE_BUILD_PURPOSES),
  origin: z.enum(["repository", "source"]),
  repo: githubRepositorySchema,
  /** Absent: the default branch. */
  ref: gitRefSchema.optional(),
  /** The commit the ref resolved to when the build was started. */
  commit: gitShaSchema.optional(),
  buildCommand: buildCommandChoiceSchema.optional(),
  /** For a catalog app built from source: its catalog manifest. */
  baseline: catalogManifestSchema.optional(),
  /** Versions the install's other builds use, which this one must not replace. */
  avoidVersions: z.array(buildVersionSchema).max(16).default([]),
  instanceType: sandboxInstanceTypeSchema.optional(),
  /** The admin confirmed the build's cost on Workers Paid. */
  costConfirmed: z.boolean(),
  /**
   * The `sandbox_enable` job that turns sandbox builds on first, when they
   * were off at the start; the build waits for it.
   */
  sandboxEnableJob: sandboxEnableJobField,
  /**
   * A private repository: the GitHub access token that read its branches and
   * tags, by id and label (its value stays on the sandbox Worker). The build
   * clones with the same one.
   */
  githubToken: z.object({ id: githubTokenIdSchema, label: z.string().min(1).max(100) }).optional(),
});
export type SourceBuildJobParams = z.infer<typeof sourceBuildJobParams>;

/** The request the job sends, for a given attempt. */
export function repositoryBuildRequest(
  params: SourceBuildJobParams,
  attempt: number,
): RepositoryBuildRequest {
  return repositoryBuildRequestSchema.parse({
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: params.installId,
    runId: sourceBuildRunId(params.jobId),
    repo: params.repo,
    ...(params.ref === undefined ? {} : { ref: params.ref }),
    ...(params.commit === undefined ? {} : { commit: params.commit }),
    ...(params.buildCommand === undefined ? {} : { buildCommand: params.buildCommand }),
    ...(params.baseline === undefined ? {} : { baseline: params.baseline }),
    avoidVersions: params.avoidVersions,
    ...(params.instanceType === undefined ? {} : { instanceType: params.instanceType }),
    ...(params.githubToken === undefined
      ? {}
      : { tokenSecret: githubTokenSecretName(params.githubToken.id) }),
    attempt,
  });
}

function tailLines(text: string, lines: number): string[] {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  while (all.length > 0 && all.at(-1)?.trim() === "") all.pop();
  return all.slice(-lines);
}

export async function runSourceBuild(ctx: JobContext): Promise<void> {
  const parsed = sourceBuildJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid source build job payload");
  const params = parsed.data;
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;

  try {
    await run("start", async ({ log, orm }) => {
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "running", started_at: at })
        .where(eq(jobs.id, params.jobId));
      log.info(
        params.origin === "repository"
          ? `Building ${params.repo} at ${params.ref ?? "its default branch"} for review. Not from the catalog, not checked.`
          : `Building ${params.baseline?.name ?? params.repo} from source at ${params.ref ?? "its default branch"} for review. The catalog did not check this commit.`,
      );
      return {};
    });
    if (params.sandboxEnableJob !== undefined) {
      await awaitSandboxEnabledPhase(steps, step, env, params.sandboxEnableJob);
    }

    const checked = await run("check sandbox Worker", async ({ log, orm }) => {
      if (!params.costConfirmed) {
        throw new JobError(
          "the build runs in the account's sandbox Worker on Workers Paid; confirm its cost to build",
        );
      }
      const binding = sandboxBinding(env);
      if (binding === undefined) {
        throw new JobError(
          "Appflare is not connected to a sandbox Worker; enable sandbox builds (Settings, Sandbox builds) and try again",
        );
      }
      let info: Awaited<ReturnType<typeof sandboxInfo>>;
      try {
        info = await sandboxInfo(binding);
      } catch (error) {
        if (error instanceof SandboxProtocolError) throw new JobError(error.message);
        throw error;
      }
      if (!buildsFromRepository(info)) {
        throw new JobError(
          `the sandbox Worker ${info.sandboxVersion} cannot build from a repository; to update it, ${UPDATE_SANDBOX_HINT}`,
        );
      }
      const dirsRefused = installDirsRefusal(info, params.baseline, UPDATE_SANDBOX_HINT);
      if (dirsRefused !== null) throw new JobError(dirsRefused);
      const patchRefused = configPatchRefusal(info, params.baseline, UPDATE_SANDBOX_HINT);
      if (patchRefused !== null) throw new JobError(patchRefused);
      if (params.githubToken !== undefined && !usesGithubTokens(info)) {
        throw new JobError(
          `the sandbox Worker ${info.sandboxVersion} cannot clone with a GitHub access token; to update it, ${UPDATE_SANDBOX_HINT}`,
        );
      }
      if (params.githubToken !== undefined) {
        log.info(
          `The repository is private: the sandbox Worker clones it with the GitHub access token "${params.githubToken.label}", which it holds; Appflare never sees the token.`,
        );
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      log.info(`The sandbox Worker ${info.sandboxVersion} builds with ${info.image}.`);
      return { accountId: settings.account_id };
    });
    steps.setAccountId(checked.accountId);

    await awaitSandboxSettledPhase(steps, checked.accountId);

    const built = await run(
      "build in sandbox",
      async ({ log, attempt }) => {
        const binding = sandboxBinding(env);
        if (binding === undefined) throw new JobError("the SANDBOX binding went away");
        let outcome: ReturnType<typeof parseRepositoryBuildOutcome>;
        try {
          // A retry builds in a container of its own (see the request's `attempt`).
          outcome = parseRepositoryBuildOutcome(
            await binding.buildRepository(repositoryBuildRequest(params, attempt)),
          );
        } catch (error) {
          if (error instanceof SandboxProtocolError) throw new JobError(error.message);
          throw error;
        }
        for (const line of tailLines(outcome.log, BUILD_LOG_LINES)) log.log("debug", line);
        if (
          !outcome.ok &&
          params.githubToken !== undefined &&
          outcome.message.includes("does not hold the GitHub access token")
        ) {
          // Added a moment ago: the version of the sandbox Worker that ran
          // the build may predate the token's secret.
          const token = await readGithubToken(env.DB, params.githubToken.id);
          if (token !== null && addedJustNow(token, new Date(now()))) {
            throw new JobError(justAddedMessage(params.githubToken.label));
          }
        }
        if (!outcome.ok) {
          const message = `the build failed in its ${outcome.stage} step${outcome.exitCode === null ? "" : ` (exit code ${outcome.exitCode})`}: ${outcome.message}`;
          if (outcome.retryable) throw new Error(message);
          throw new JobError(message);
        }
        const prefix = `builds/${params.installId}/${outcome.version}/`;
        if (
          outcome.installId !== params.installId ||
          !outcome.manifestKey.startsWith(prefix) ||
          !outcome.artifactKey.startsWith(prefix)
        ) {
          throw new JobError("the sandbox Worker stored the build under unexpected keys");
        }
        if (params.commit !== undefined && outcome.commit !== params.commit) {
          throw new JobError(
            `the sandbox Worker built ${outcome.commit}, not ${params.commit} as asked`,
          );
        }
        log.info(
          `Built ${params.repo} at ${outcome.ref} (${outcome.commit.slice(0, 12)}) as version ${outcome.version} in ${outcome.minutes} minute(s) with ${outcome.image} (${outcome.size} bytes, unsigned).`,
        );
        return {
          digest: outcome.digest,
          version: outcome.version,
          commit: outcome.commit,
          ref: outcome.ref,
          manifestKey: outcome.manifestKey,
          artifactKey: outcome.artifactKey,
          image: outcome.image,
          detected: outcome.detected,
          builtAt: new Date(now()).toISOString(),
        };
      },
      SANDBOX_BUILD_STEP,
    );

    await run("verify built manifest", async ({ log, orm }) => {
      const file = await fetchWhole(sandboxFetch(env), sandboxObjectUrl(built.manifestKey));
      const manifest = await verifySourceBuildManifest(file.bytes, {
        repo: params.repo,
        commit: built.commit,
        version: built.version,
        digest: built.digest,
        ...(params.baseline === undefined
          ? {}
          : { slug: params.baseline.slug, baseline: params.baseline }),
      });
      if (
        built.artifactKey !==
        `builds/${params.installId}/${built.version}/${manifest.app}-${built.version}.zip`
      ) {
        throw new JobError("the build's zip is not where its manifest says it is");
      }
      const at = new Date(now());
      await orm
        .update(source_builds)
        .set({
          status: "built",
          commit_sha: built.commit,
          ref: built.ref,
          version: built.version,
          digest: built.digest,
          manifest_key: built.manifestKey,
          artifact_key: built.artifactKey,
          image: built.image,
          manifest_json: new TextDecoder().decode(file.bytes),
          detected_json: JSON.stringify(built.detected),
          built_at: new Date(built.builtAt),
          updated_at: at,
        })
        .where(and(eq(source_builds.id, params.jobId), eq(source_builds.status, "building")));
      log.info(
        `Verified the built manifest.json of ${manifest.app} ${manifest.version}: unsigned, from ${params.repo} at ${built.commit.slice(0, 12)}.`,
      );
      return {};
    });

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "succeeded", finished_at: at, error: null })
        .where(eq(jobs.id, params.jobId));
      log.info(
        `Built. Review what it declares before ${params.purpose === "update" ? "updating" : "installing"}: /catalog/source/${params.jobId}`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark source build failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      await orm
        .update(source_builds)
        .set({ status: "failed", updated_at: at })
        .where(and(eq(source_builds.id, params.jobId), eq(source_builds.status, "building")));
      const log = new StepLog(now);
      log.error(`The build failed at "${steps.current}". Nothing was deployed.`);
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
