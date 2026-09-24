import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireRole } from "../server/auth.server";
import {
  type ChannelSaved,
  type ChannelView,
  channelIdInput,
  createChannelInput,
  type TestResult,
  updateChannelInput,
} from "./channels";
import {
  ChannelError,
  createChannel,
  deleteChannel,
  listChannels,
  replaceSigningSecret,
  sendTest,
  updateChannel,
} from "./channels.server";

/**
 * Settings, Notification channels. Admins only, reading included: a
 * channel's target (a chat id, a webhook host) is not for every member.
 * Each call that changes or tests a channel also remembers the origin the
 * admin uses, so messages link back to the same manager URL.
 */

function origin(): string {
  return new URL(getRequest().url).origin;
}

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ChannelError) throw new Error(error.message);
    throw error;
  }
}

export const listNotificationChannels = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChannelView[]> => {
    await requireRole("admin");
    return listChannels(env);
  },
);

export const createNotificationChannel = createServerFn({ method: "POST" })
  .validator(createChannelInput)
  .handler(async ({ data }): Promise<ChannelSaved> => {
    await requireRole("admin");
    return asUserError(() => createChannel(env, data, { origin: origin() }));
  });

export const updateNotificationChannel = createServerFn({ method: "POST" })
  .validator(updateChannelInput)
  .handler(async ({ data }): Promise<ChannelView> => {
    await requireRole("admin");
    return asUserError(() => updateChannel(env, data, { origin: origin() }));
  });

export const deleteNotificationChannel = createServerFn({ method: "POST" })
  .validator(channelIdInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireRole("admin");
    await asUserError(() => deleteChannel(env, data.id));
    return { ok: true };
  });

export const replaceWebhookSigningSecret = createServerFn({ method: "POST" })
  .validator(channelIdInput)
  .handler(async ({ data }): Promise<ChannelSaved> => {
    await requireRole("admin");
    return asUserError(() => replaceSigningSecret(env, data.id, { origin: origin() }));
  });

export const sendTestNotification = createServerFn({ method: "POST" })
  .validator(channelIdInput)
  .handler(async ({ data }): Promise<TestResult> => {
    await requireRole("admin");
    return asUserError(() => sendTest(env, data.id, { origin: origin() }));
  });
