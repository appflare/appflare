import { releaseFetch } from "../catalog/release-fetch";
import { type CfClientEnv, getCfClient } from "../cloudflare/client.server";
import type { SandboxAutoEnableDeps } from "./auto-enable.server";
import type { SandboxEnableJobParams } from "./enable-job";
import { sandboxReleaseProblem } from "./release";

/** What the install and build starts pass to turn sandbox builds on at first need. */
export function sandboxAutoEnableDeps(
  env: CfClientEnv & {
    GITHUB_TOKEN?: string;
    MANAGER_RELEASES_URL?: string;
    APPFLARE_VERSION: string;
    JOBS: {
      create(options: { id: string; params: SandboxEnableJobParams }): Promise<{ id: string }>;
    };
  },
): SandboxAutoEnableDeps {
  const userAgent = `Appflare/${env.APPFLARE_VERSION}`;
  const viaApi = typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0;
  return {
    client: () => getCfClient(env),
    releaseProblem: (version) =>
      sandboxReleaseProblem(
        releaseFetch((input, init) => fetch(input, init), { token: env.GITHUB_TOKEN, userAgent }),
        env,
        version,
        { viaApi },
      ),
    createJob: (id, params) => env.JOBS.create({ id, params }),
    currentVersion: env.APPFLARE_VERSION,
  };
}
