import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { CustomDomainError } from "../installs/custom-domains.server";
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

export type {
  AddressOptions,
  ManagerAddress,
  MoveAddressResult,
  RevertResult,
} from "./manager-address.server";

/**
 * Settings, Domains, "Appflare's address": read it, the zones it can move
 * to, move it to a custom domain, change it, go back to workers.dev. All
 * admin only; every call goes through the manager's own `CF_API_TOKEN`.
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
      throw new Error(error.message);
    }
    throw error;
  }
}

async function deps() {
  return {
    db: env.DB,
    api: await getCfClient(env),
    fetch: (input: string, init?: RequestInit) => fetch(input, init),
    version: runningVersion(env),
  };
}

/** Where Appflare lives, and custom domains attached to its Worker by hand. */
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
 * Moves Appflare from workers.dev to a custom domain, or reports the DNS
 * records the domain would replace. On success, `url` is the sign-in page
 * at the new address, where the browser goes next.
 */
export const moveManagerAddress = createServerFn({ method: "POST" })
  .validator(moveAddressInput)
  .handler(async ({ data }): Promise<MoveAddressResult> => {
    await requireRole("admin");
    return asUserError(async () => moveCore(await deps(), data));
  });

/** Moves Appflare from its custom domain to another, then detaches the one it left. */
export const changeManagerAddress = createServerFn({ method: "POST" })
  .validator(moveAddressInput)
  .handler(async ({ data }): Promise<MoveAddressResult> => {
    await requireRole("admin");
    return asUserError(async () => changeCore(await deps(), data));
  });

/** Back to workers.dev; `url` is the sign-in page there. */
export const revertManagerAddress = createServerFn({ method: "POST" })
  .validator(revertAddressInput)
  .handler(async ({ data }): Promise<RevertResult> => {
    await requireRole("admin");
    return asUserError(async () => revertCore(await deps(), data));
  });
