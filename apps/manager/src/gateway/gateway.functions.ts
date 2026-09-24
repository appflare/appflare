import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { requireRole, requireSession } from "../server/auth.server";
import { zoneIdSchema } from "./gateway";
import {
  checkGatewayZoneCore,
  GatewayError,
  type GatewayView,
  getGatewayViewCore,
  setUpGatewayCore,
  turnOffGatewayCore,
  type ZoneSaasCheck,
} from "./gateway.server";

/**
 * Settings > Domains: the external domains gateway. Reading it is open to
 * every signed-in user (members see where it runs); checking a zone,
 * setting up and turning off are admin only.
 */

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GatewayError || error instanceof CfTokenNotConfiguredError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

const zoneInput = z.object({ zoneId: zoneIdSchema });

function deps() {
  return getCfClient(env).then((api) => ({
    db: env.DB,
    api,
    fetch: (input: string, init?: RequestInit) => fetch(input, init),
  }));
}

export const getGatewayView = createServerFn({ method: "GET" }).handler(
  async (): Promise<GatewayView | { error: string }> => {
    await requireSession();
    try {
      return await asUserError(async () => getGatewayViewCore(await deps()));
    } catch (error) {
      // The page still renders (with the reason) when the token is not set up.
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
);

/** Whether the zone can be the gateway: Cloudflare for SaaS on, and the token allowed to use it. */
export const checkGatewayZone = createServerFn({ method: "POST" })
  .validator(zoneInput)
  .handler(async ({ data }): Promise<ZoneSaasCheck & { zoneName: string }> => {
    await requireRole("admin");
    return asUserError(async () => checkGatewayZoneCore(await deps(), data));
  });

export const setUpGateway = createServerFn({ method: "POST" })
  .validator(zoneInput)
  .handler(async ({ data }): Promise<{ zoneName: string }> => {
    await requireRole("admin");
    return asUserError(async () => {
      const state = await setUpGatewayCore(await deps(), data);
      return { zoneName: state.zoneName };
    });
  });

export const turnOffGateway = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    await requireRole("admin");
    return asUserError(async () => {
      await turnOffGatewayCore(await deps());
      return { ok: true as const };
    });
  },
);
