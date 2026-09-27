import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole } from "../server/auth.server";
import { customDomainInput } from "./custom-domain-input";
import { startVarsRefreshCore } from "./reconfigure.server";
import { addWildcardDomainInput } from "./wildcard-domain-input";
import {
  addWildcardDomainCore,
  removeWildcardDomainCore,
  type VarsRefresh,
  type WildcardDomainDeps,
  WildcardDomainError,
  WildcardDomainTransientError,
} from "./wildcard-domains.server";

/**
 * The wildcard domain of an install (an app that needs every name under one
 * hostname): add it, remove it. Admin only. Checking it is the custom domain
 * check (`checkCustomDomain`), through its base hostname.
 */

/** The request's deps, with the settings refresh a settings change would run. */
async function deps(): Promise<WildcardDomainDeps> {
  return {
    db: env.DB,
    api: await getCfClient(env),
    refreshVars: (installId) =>
      startVarsRefreshCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          sandboxConnected: sandboxBinding(env) !== undefined,
          createJob: (id, params) => env.JOBS.create({ id, params }),
        },
        installId,
      ),
  };
}

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof WildcardDomainError ||
      error instanceof WildcardDomainTransientError ||
      error instanceof CfTokenNotConfiguredError
    ) {
      throw new Error(error.message);
    }
    throw error;
  }
}

/** Serves the base hostname and every name under it with the install's Worker. */
export const addWildcardDomain = createServerFn({ method: "POST" })
  .validator(addWildcardDomainInput)
  .handler(async ({ data }): Promise<{ resourceId: string; hostname: string } & VarsRefresh> => {
    await requireRole("admin");
    return asUserError(async () => addWildcardDomainCore(await deps(), data));
  });

/** Removes the wildcard domain's routes and records and marks it deleted. */
export const removeWildcardDomain = createServerFn({ method: "POST" })
  .validator(customDomainInput)
  .handler(async ({ data }): Promise<{ hostname: string } & VarsRefresh> => {
    await requireRole("admin");
    return asUserError(async () => removeWildcardDomainCore(await deps(), data));
  });
