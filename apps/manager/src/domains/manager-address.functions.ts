import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { accessGate } from "../access/gate";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { inConnectionWordsOf } from "../cloudflare/sign-in-words.server";
import { CustomDomainError } from "../installs/custom-domains.server";
import { jobCreator } from "../jobs/create-job.server";
import { requireRole } from "../server/auth.server";
import { runningVersion } from "../server/build-version";
import {
  type AddressOptions,
  changeManagerAddress as changeCore,
  listAddressOptions,
  type ManagerAddress,
  ManagerAddressError,
  type MoveAddressResult,
  moveManagerAddress as moveCore,
  type RevertResult,
  readManagerAddress,
  revertManagerAddress as revertCore,
} from "./manager-address.server";
import { moveAddressInput, revertAddressInput } from "./manager-address-input";
import {
  retryPendingMove as retryPendingCore,
  stayAtWorkersDev as stayCore,
} from "./pending-address.server";

export type {
  AddressOptions,
  ManagerAddress,
  MoveAddressResult,
  RevertResult,
} from "./manager-address.server";

/**
 * Settings, Domains, "Appflare's address": read it, the zones it can move
 * to, move it to a custom domain, change it, go back to workers.dev. All
 * admin only; every call goes through the manager's own Cloudflare connection.
 */

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof ManagerAddressError ||
      error instanceof CustomDomainError ||
      error instanceof CfTokenNotConfiguredError
    ) {
      throw new Error(await inConnectionWordsOf(env.DB, error.message));
    }
    throw error;
  }
}

async function deps() {
  return {
    db: env.DB,
    api: await getCfClient(env),
    version: runningVersion(env),
    createJob: jobCreator(env.JOBS),
    workflows: env.JOBS,
    invalidateAccessGate: () => accessGate.invalidate(),
  };
}

/**
 * Where Appflare lives, custom domains attached to its Worker by hand, and
 * the move job running, if any.
 */
export const getManagerAddress = createServerFn({ method: "GET" }).handler(
  async (): Promise<ManagerAddress> => {
    await requireRole("admin");
    return asUserError(async () => readManagerAddress(await deps()));
  },
);

/** The active zones Appflare can move to, with a suggested hostname each. */
export const getManagerAddressOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<AddressOptions> => {
    await requireRole("admin");
    return asUserError(async () => listAddressOptions(await deps()));
  },
);

/**
 * Starts moving Appflare from workers.dev to a custom domain, or reports the
 * DNS records the domain would replace. On success, `jobId` is the job that
 * waits for the new address and switches, and `url` the sign-in page at the
 * new address, where the browser goes once the job succeeded.
 */
export const moveManagerAddress = createServerFn({ method: "POST" })
  .validator(moveAddressInput)
  .handler(async ({ data }): Promise<MoveAddressResult> => {
    await requireRole("admin");
    return asUserError(async () => moveCore(await deps(), data));
  });

/** Starts moving Appflare from its custom domain to another; the job detaches the one it left. */
export const changeManagerAddress = createServerFn({ method: "POST" })
  .validator(moveAddressInput)
  .handler(async ({ data }): Promise<MoveAddressResult> => {
    await requireRole("admin");
    return asUserError(async () => changeCore(await deps(), data));
  });

/**
 * Try again, after the automatic move to the pending address failed: one
 * move there, started by this admin and followed like any other.
 */
export const retryPendingMove = createServerFn({ method: "POST" })
  .validator(revertAddressInput)
  .handler(async ({ data }): Promise<MoveAddressResult> => {
    await requireRole("admin");
    return asUserError(async () => retryPendingCore(await deps(), data));
  });

/** Stay at workers.dev: Appflare no longer moves to the pending address by itself. */
export const stayAtWorkersDev = createServerFn({ method: "POST" }).handler(async () => {
  await requireRole("admin");
  await stayCore(env.DB);
});

/** Back to workers.dev; `url` is the sign-in page there. */
export const revertManagerAddress = createServerFn({ method: "POST" })
  .validator(revertAddressInput)
  .handler(async ({ data }): Promise<RevertResult> => {
    await requireRole("admin");
    return asUserError(async () => revertCore(await deps(), data));
  });
