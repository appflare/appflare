import type { FetchLike } from "@appflare/cf-api";
import {
  type BuildOutcome,
  type BuildProgress,
  buildOutcomeSchema,
  buildProgressSchema,
  GITHUB_FETCH_HEADERS,
  type RepositoryBuildOutcome,
  repositoryBuildOutcomeSchema,
  SANDBOX_FEATURE_GITHUB_TOKENS,
  SANDBOX_FEATURE_INSTALL_DIRS,
  SANDBOX_FEATURE_REPOSITORY,
  SANDBOX_FEATURE_SELF_DEPLOYING,
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_URL_ORIGIN,
  type SandboxInfo,
  type SelfManagedOutcome,
  type SelfManagedStatus,
  sandboxInfoSchema,
  selfManagedOutcomeSchema,
  selfManagedStatusSchema,
} from "@appflare/schema";
import { z } from "zod";
import { UPDATE_SANDBOX_HINT } from "./connect-copy";

/**
 * The manager's `SANDBOX` service binding to the sandbox Worker
 * (`appflare-sandbox`, entrypoint `SandboxBuilds`). It exists only on
 * accounts where the admin enabled sandbox builds and the manager was
 * connected to them, so every caller treats it as optional. Whether sandbox
 * builds are available is read from the running Worker's own bindings, never
 * from a stored setting that could drift from them.
 *
 * Everything that crosses the binding is data from another Worker: results
 * are parsed with the shared protocol schemas before use.
 */

/** The binding's name on the manager's Worker. */
export const SANDBOX_BINDING = "SANDBOX";

/** The RPC surface of `SandboxBuilds`, as the manager calls it. */
export interface SandboxBuildsBinding {
  /** Build objects by URL path (`https://sandbox/builds/...`), with Range support. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  info(): Promise<unknown>;
  build(request: unknown): Promise<unknown>;
  /** Builds from a repository (sandbox Workers whose `info().features` lists it). */
  buildRepository(request: unknown): Promise<unknown>;
  progress(input: unknown): Promise<unknown>;
  cleanup(input: unknown): Promise<unknown>;
  /** Self-deploying tier (sandbox Workers whose `info().features` lists it). */
  deploySelfManaged(request: unknown): Promise<unknown>;
  destroySelfManaged(request: unknown): Promise<unknown>;
  selfManagedStatus(request: unknown): Promise<unknown>;
  /**
   * One GET to GitHub with a GitHub access token the sandbox Worker holds
   * (sandbox Workers whose `info().features` lists `github-tokens`).
   */
  githubFetch(request: unknown): Promise<Response>;
}

/**
 * The `SANDBOX` binding of an env, or undefined when this deployment has
 * none. The generated binding type (when there is one) wraps RPC results in
 * stubs; the entrypoint returns plain data, which arrives as plain data.
 */
export function sandboxBinding(env: { SANDBOX?: unknown }): SandboxBuildsBinding | undefined {
  const binding: unknown = env.SANDBOX;
  return binding === undefined || binding === null ? undefined : (binding as SandboxBuildsBinding);
}

/**
 * A fetch that reads sandbox build objects through the binding. Without the
 * binding every read fails the same way, retryably: the admin can reconnect
 * sandbox builds and retry the job.
 */
export function sandboxFetch(env: { SANDBOX?: unknown }): FetchLike {
  return async (input, init) => {
    const binding = sandboxBinding(env);
    if (binding === undefined) {
      throw new Error("this manager has no SANDBOX binding to read the sandbox build through");
    }
    // Only the sandbox Worker's own object URLs go through the binding.
    if (!input.startsWith(`${SANDBOX_URL_ORIGIN}/`)) {
      throw new Error(`${input} is not a sandbox build object`);
    }
    return binding.fetch(input, init);
  };
}

/** A sandbox Worker that answered in a way the manager cannot use. */
export class SandboxProtocolError extends Error {
  override name = "SandboxProtocolError";
}

/** `info()`, checked: the sandbox Worker must speak this manager's protocol version. */
export async function sandboxInfo(binding: SandboxBuildsBinding): Promise<SandboxInfo> {
  const parsed = sandboxInfoSchema.safeParse(await binding.info());
  if (!parsed.success) {
    throw new SandboxProtocolError("the sandbox Worker answered info() with an unexpected shape");
  }
  if (parsed.data.protocol !== SANDBOX_PROTOCOL_VERSION) {
    throw new SandboxProtocolError(
      `the sandbox Worker ${parsed.data.sandboxVersion} speaks protocol ${parsed.data.protocol}, this manager speaks ${SANDBOX_PROTOCOL_VERSION}; ${parsed.data.protocol < SANDBOX_PROTOCOL_VERSION ? `to update the sandbox Worker, ${UPDATE_SANDBOX_HINT}` : "update Appflare"}`,
    );
  }
  return parsed.data;
}

/** `build()`'s answer, checked. */
export function parseBuildOutcome(value: unknown): BuildOutcome {
  const parsed = buildOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    throw new SandboxProtocolError(
      `the sandbox Worker answered build() with an unexpected shape (${z.prettifyError(parsed.error).replace(/\s+/g, " ")})`,
    );
  }
  return parsed.data;
}

/** Whether the sandbox Worker builds from a repository (`buildRepository`). */
export function buildsFromRepository(info: SandboxInfo): boolean {
  return info.features?.includes(SANDBOX_FEATURE_REPOSITORY) === true;
}

/** `buildRepository()`'s answer, checked. */
export function parseRepositoryBuildOutcome(value: unknown): RepositoryBuildOutcome {
  const parsed = repositoryBuildOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    throw new SandboxProtocolError(
      `the sandbox Worker answered buildRepository() with an unexpected shape (${z.prettifyError(parsed.error).replace(/\s+/g, " ")})`,
    );
  }
  return parsed.data;
}

/**
 * Whether the sandbox Worker builds an entry that lists `install.installDirs`
 * by letting its packer install those directories. One without it would run
 * the root install alone.
 */
export function installsListedDirs(info: Pick<SandboxInfo, "features">): boolean {
  return info.features?.includes(SANDBOX_FEATURE_INSTALL_DIRS) === true;
}

/**
 * Why the sandbox Worker cannot build `catalog`, or null when it can: the
 * entry lists install directories and the sandbox Worker predates them.
 */
export function installDirsRefusal(
  info: Pick<SandboxInfo, "sandboxVersion" | "features">,
  catalog: { install: { installDirs?: readonly unknown[] | undefined } } | undefined,
  updateHint: string,
): string | null {
  if (catalog?.install.installDirs === undefined || installsListedDirs(info)) return null;
  return `the sandbox Worker ${info.sandboxVersion} cannot install the directories this app lists (install.installDirs); to update it, ${updateHint}`;
}

/** Whether the sandbox Worker holds GitHub access tokens and reads GitHub with them. */
export function usesGithubTokens(info: SandboxInfo): boolean {
  return info.features?.includes(SANDBOX_FEATURE_GITHUB_TOKENS) === true;
}

/**
 * A fetch that sends each request to GitHub through the sandbox Worker, with
 * the GitHub access token held there as `tokenSecret`. Only GitHub URLs and
 * the headers GitHub needs are passed on; the answer is GitHub's, redirects
 * unfollowed. The token itself never reaches this Worker.
 */
export function sandboxGithubFetch(binding: SandboxBuildsBinding, tokenSecret: string): FetchLike {
  return async (input, init) => {
    const given = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    for (const name of GITHUB_FETCH_HEADERS) {
      const value = given.get(name);
      if (value !== null) headers[name] = value;
    }
    return binding.githubFetch({
      protocol: SANDBOX_PROTOCOL_VERSION,
      url: input,
      tokenSecret,
      headers,
    });
  };
}

/** Whether the sandbox Worker runs self-deploying apps' installers. */
export function runsSelfDeploying(info: SandboxInfo): boolean {
  return info.features?.includes(SANDBOX_FEATURE_SELF_DEPLOYING) === true;
}

/** `deploySelfManaged()`'s or `destroySelfManaged()`'s answer, checked. */
export function parseSelfManagedOutcome(value: unknown): SelfManagedOutcome {
  const parsed = selfManagedOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    throw new SandboxProtocolError(
      `the sandbox Worker answered a self-deploying run with an unexpected shape (${z.prettifyError(parsed.error).replace(/\s+/g, " ")})`,
    );
  }
  return parsed.data;
}

/** `selfManagedStatus()`'s answer, checked. */
export function parseSelfManagedStatus(value: unknown): SelfManagedStatus {
  const parsed = selfManagedStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new SandboxProtocolError(
      "the sandbox Worker answered selfManagedStatus() with an unexpected shape",
    );
  }
  return parsed.data;
}

/** `progress()`'s answer, checked; null when there is no such build or the answer is unusable. */
export function parseBuildProgress(value: unknown): BuildProgress | null {
  const parsed = buildProgressSchema.nullable().safeParse(value);
  return parsed.success ? parsed.data : null;
}
