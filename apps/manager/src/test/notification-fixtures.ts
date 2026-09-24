import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { CATALOG_INDEX_KEY } from "../catalog/index.server";
import { MANAGER_LATEST_KEY } from "../catalog/manager-releases.server";
import type { CreateChannelInput } from "../notifications/channels";
import { createChannel } from "../notifications/channels.server";

/**
 * Test-only: notification channels with made-up credentials, and a recording
 * stand-in for the services they post to (Telegram, Slack, Discord, a
 * webhook receiver). Nothing here reaches the network.
 */

export const SECRET = "test-better-auth-secret-0123456789abcdef";
export const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";
export const CHAT_ID = "-1001234567890";
export const SLACK_URL =
  "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";
export const DISCORD_URL =
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
export const HOOK_URL = "https://hooks.example.test/appflare?token=receiver-token-123";
export const MANAGER = "https://appflare.ada.workers.dev";

export const channelsEnv = () => ({ DB: env.DB, BETTER_AUTH_SECRET: SECRET });

export interface Posted {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Answers every POST with `status` (or what `reply` returns for its URL) and
 * records it.
 */
export function services(reply: (url: string) => Response | number = () => 200): {
  fetch: FetchLike;
  posted: Posted[];
} {
  const posted: Posted[] = [];
  return {
    posted,
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      posted.push({ url, headers, body: String(init?.body ?? "") });
      const r = reply(url);
      if (typeof r !== "number") return r;
      if (url.startsWith("https://api.telegram.org/")) {
        return Response.json(
          r === 200
            ? { ok: true, result: {} }
            : { ok: false, description: "Bad Request: chat not found" },
          { status: r },
        );
      }
      if (url.startsWith("https://discord.com/"))
        return new Response(null, { status: r === 200 ? 204 : r });
      return new Response(r === 200 ? "ok" : "no_service", { status: r });
    },
  };
}

export const TELEGRAM: CreateChannelInput = {
  label: "Ops chat",
  events: [
    "update_available",
    "update_applied",
    "update_failed",
    "install_finished",
    "uninstall_finished",
    "health_failing",
    "manager_update_available",
  ],
  settings: { kind: "telegram", botToken: BOT_TOKEN, chatId: CHAT_ID },
};

export async function addChannel(input: CreateChannelInput = TELEGRAM, now = Date.now()) {
  return createChannel(channelsEnv(), input, { now: () => now });
}

/** Caches a catalog index listing `cut` at `version`. */
export async function cacheCatalog(version: string): Promise<void> {
  await env.KV.put(
    CATALOG_INDEX_KEY,
    JSON.stringify({
      generatedAt: "2026-09-24T00:00:00.000Z",
      apps: [
        {
          slug: "cut",
          name: "Cut",
          summary: "Self-hosted link shortener on Workers + KV.",
          version,
          artifacts: {
            zip: "https://artifacts.test/cut.zip",
            manifest: "https://artifacts.test/manifest.json",
            sig: "https://artifacts.test/manifest.sig",
          },
          digest: "a".repeat(64),
          tier: "artifact",
          plan: "free",
          requires: [],
          lastVerified: null,
          maintainers: ["MendyLanda"],
        },
      ],
    }),
  );
}

/** Caches `version` as the newest Appflare release. */
export async function cacheManagerRelease(version: string): Promise<void> {
  await env.KV.put(
    MANAGER_LATEST_KEY,
    JSON.stringify({
      version,
      tag: `manager@${version}`,
      assets: {
        zip: `https://github.test/appflare-${version}.zip`,
        manifest: "https://github.test/manifest.json",
        sig: "https://github.test/manifest.sig",
      },
      publishedAt: null,
      checkedAt: "2026-09-24T00:00:00.000Z",
    }),
  );
}
