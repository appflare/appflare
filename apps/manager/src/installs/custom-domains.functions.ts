import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { accessAddressSync } from "../access/address-sync.server";
import { probeHeadersFromEnv } from "../access/probe-credentials.server";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { requireRole } from "../server/auth.server";
import { addCustomDomainInput, customDomainInput } from "./custom-domain-input";
import {
  type AddCustomDomainResult,
  addCustomDomainCore,
  type CustomDomainCheck,
  CustomDomainError,
  checkCustomDomainCore,
  type DomainOptions,
  getDomainOptionsCore,
  removeCustomDomainCore,
} from "./custom-domains.server";
import { varsRefresher } from "./reconfigure.server";
import type { VarsRefresh } from "./vars-refresh.server";

/** Custom domains of an install: what can be added, add one, remove one, check one. All admin only. */

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CustomDomainError || error instanceof CfTokenNotConfiguredError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

/** The active zones the token can see, and the custom domain permissions it lacks. */
export const getDomainOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<DomainOptions> => {
    await requireRole("admin");
    return asUserError(async () =>
      getDomainOptionsCore({ db: env.DB, api: await getCfClient(env) }),
    );
  },
);

/** Attaches a hostname to the install's Worker, or reports the DNS records it would replace. */
export const addCustomDomain = createServerFn({ method: "POST" })
  .validator(addCustomDomainInput)
  .handler(async ({ data }): Promise<AddCustomDomainResult> => {
    await requireRole("admin");
    return asUserError(async () =>
      addCustomDomainCore({ db: env.DB, api: await getCfClient(env) }, data),
    );
  });

/** Detaches a custom domain and marks it deleted. */
export const removeCustomDomain = createServerFn({ method: "POST" })
  .validator(customDomainInput)
  .handler(async ({ data }): Promise<{ hostname: string } & VarsRefresh> => {
    await requireRole("admin");
    return asUserError(async () =>
      removeCustomDomainCore(
        { db: env.DB, api: await getCfClient(env), refreshVars: varsRefresher(env) },
        data,
      ),
    );
  });

/**
 * One probe of the app on the custom domain. When the app answers, the domain
 * is live, and workers.dev may be turned off (unless an admin set its switch).
 */
export const checkCustomDomain = createServerFn({ method: "POST" })
  .validator(customDomainInput)
  .handler(async ({ data }): Promise<CustomDomainCheck> => {
    await requireRole("admin");
    return asUserError(() =>
      checkCustomDomainCore(
        {
          db: env.DB,
          fetch: (input, init) => fetch(input, init),
          probeHeaders: probeHeadersFromEnv(env),
          api: () => getCfClient(env),
          refreshVars: varsRefresher(env),
          syncAccess: accessAddressSync(env.DB, () => getCfClient(env)),
        },
        data,
      ),
    );
  });
