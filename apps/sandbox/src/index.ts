import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type BuildOutcome,
  type BuildProgress,
  buildCleanupRequestSchema,
  buildKeys,
  buildProgressRequestSchema,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxInfo,
  sandboxImage,
} from "@appflare/schema";
import { runBuild } from "./build";
import { readProgress } from "./log";
import { serveBuildObject } from "./range";
import { openBuildSandbox } from "./sandbox";
import { deleteInstallBuilds } from "./storage";

// The container runtime's proxy, which carries the build containers' outbound
// traffic (including the credential-less R2 mount) through this Worker.
export { ContainerProxy } from "@cloudflare/sandbox";
export { LargeSandbox, Sandbox } from "./sandbox";

/**
 * The sandbox Worker's RPC surface for the manager, reached through the manager's
 * `SANDBOX` service binding (the Worker has no public URL). Inputs are
 * validated here: RPC arguments are data from another Worker.
 */
export class SandboxBuilds extends WorkerEntrypoint<Env> {
  /** Protocol and version, checked by the manager before it trusts this sandbox Worker. */
  info(): SandboxInfo {
    return {
      protocol: SANDBOX_PROTOCOL_VERSION,
      sandboxVersion: this.env.APPFLARE_VERSION,
      image: sandboxImage(this.env.APPFLARE_VERSION),
    };
  }

  /**
   * Builds one app version in a Sandbox container and stores the unsigned
   * artifact under `builds/<installId>/<version>/`. Resolves when the build
   * is done (typically minutes); the caller stays connected meanwhile.
   */
  build(request: unknown): Promise<BuildOutcome> {
    return runBuild(request, {
      bucket: this.env.BUILDS,
      sandboxVersion: this.env.APPFLARE_VERSION,
      openSandbox: (id, instanceType) => openBuildSandbox(this.env, id, instanceType),
    });
  }

  /**
   * The state and log of a running or finished build, or null when there is
   * none. The log's `updatedAt` stops moving if a build died without
   * finishing; the caller decides when that means it is gone.
   */
  async progress(input: unknown): Promise<BuildProgress | null> {
    const { installId, version } = buildProgressRequestSchema.parse(input);
    // The log key does not depend on the slug.
    return readProgress(this.env.BUILDS, buildKeys(installId, version, "_").log);
  }

  /** Deletes an install's builds except `keepVersions`; returns how many objects went. */
  async cleanup(input: unknown): Promise<{ deleted: number }> {
    const { installId, keepVersions } = buildCleanupRequestSchema.parse(input);
    return { deleted: await deleteInstallBuilds(this.env.BUILDS, installId, keepVersions) };
  }

  /** Build objects by URL path, with Range support, for the manager's artifact reader. */
  override fetch(request: Request): Promise<Response> {
    return serveBuildObject(request, this.env.BUILDS);
  }
}

export default SandboxBuilds;
