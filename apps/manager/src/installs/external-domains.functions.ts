import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { inConnectionWordsOf } from "../cloudflare/sign-in-words.server";
import { GatewayError } from "../gateway/gateway.server";
import { requireRole, requireSession } from "../server/auth.server";
import {
  addExternalDomainInput,
  type ExternalDomainOptions,
  type ExternalDomainStatus,
  externalDomainInput,
  externalDomainStatusInput,
} from "./external-domain-input";
import {
  addExternalDomainCore,
  ExternalDomainError,
  externalDomainStatusCore,
  getExternalDomainOptionsCore,
  removeExternalDomainCore,
} from "./external-domains.server";
import { varsRefresher } from "./reconfigure.server";
import type { VarsRefresh } from "./vars-refresh.server";

/**
 * External domains of an install: what the add dialog checks against, add,
 * status (with the records the owner adds), remove. Reading the status is
 * open to every signed-in user; the rest is admin only.
 */

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof ExternalDomainError ||
      error instanceof GatewayError ||
      error instanceof CfTokenNotConfiguredError
    ) {
      throw new Error(await inConnectionWordsOf(env.DB, error.message));
    }
    throw error;
  }
}

const managerFetch = (input: string, init?: RequestInit) => fetch(input, init);

/** The gateway (when ready) and the account's zones, for checking a hostname before adding it. */
export const getExternalDomainOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<ExternalDomainOptions> => {
    await requireRole("admin");
    return asUserError(async () =>
      getExternalDomainOptionsCore({ db: env.DB, api: await getCfClient(env) }),
    );
  },
);

/** Creates the custom hostname, routes it to the app, and records it. */
export const addExternalDomain = createServerFn({ method: "POST" })
  .validator(addExternalDomainInput)
  .handler(async ({ data }): Promise<{ resourceId: string; status: ExternalDomainStatus }> => {
    await requireRole("admin");
    return asUserError(async () =>
      addExternalDomainCore({ db: env.DB, api: await getCfClient(env) }, data),
    );
  });

/**
 * Cloudflare's view of the domain now; with `probe`, one request to the app
 * through it. When an admin reads it and the app answers, workers.dev may be
 * turned off (unless an admin set its switch).
 */
export const getExternalDomainStatus = createServerFn({ method: "POST" })
  .validator(externalDomainStatusInput)
  .handler(async ({ data }): Promise<ExternalDomainStatus> => {
    const session = await requireSession();
    return asUserError(async () =>
      externalDomainStatusCore(
        {
          db: env.DB,
          api: await getCfClient(env),
          fetch: managerFetch,
          refreshVars: varsRefresher(env),
        },
        { ...data, applyDefaults: hasRole(session.user.role, "admin") },
      ),
    );
  });

/** Removes the domain at Cloudflare and marks it deleted. */
export const removeExternalDomain = createServerFn({ method: "POST" })
  .validator(externalDomainInput)
  .handler(async ({ data }): Promise<{ hostname: string } & VarsRefresh> => {
    await requireRole("admin");
    return asUserError(async () =>
      removeExternalDomainCore(
        { db: env.DB, api: await getCfClient(env), refreshVars: varsRefresher(env) },
        data,
      ),
    );
  });
