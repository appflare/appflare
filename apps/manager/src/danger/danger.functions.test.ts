import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { ACC, TOKEN } from "../test/fake-account";
import { fakeRemovalAccount, MANAGER_WORKER } from "../test/fake-removal";

/**
 * The server function behind the removal review dialog: a refusal it can
 * explain reaches the owner with its message, including Cloudflare's
 * answers without the list asked for. TanStack Start's `createServerFn` is
 * replaced by a chain that returns the handler, so it can be called here;
 * the review runs for real against the local D1 and a fake account.
 */

const { requireRole, getCfClient } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCfClient: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => {
  const chain = {
    validator: () => chain,
    inputValidator: () => chain,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => chain };
});
vi.mock("../server/auth.server", () => ({ requireRole, requireSession: vi.fn() }));
vi.mock("../server/users.server", () => ({
  ensureOwner: async () => {},
  isOwner: async () => true,
}));
vi.mock("../cloudflare/client.server", () => ({
  getCfClient,
  CfTokenNotConfiguredError: class extends Error {},
}));

const { getRemovalReview } = await import("./danger.functions");
const review = getRemovalReview as unknown as () => Promise<unknown>;

/** The removal fake, where `path` answers a success envelope without its list. */
function answersWithoutList(path: string): FetchLike {
  const account = fakeRemovalAccount();
  return async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === `/client/v4/accounts/${ACC}${path}`) {
      return Response.json({ success: true, errors: [], messages: [], result: {} });
    }
    return account.fetch(input, init);
  };
}

async function refusal(fetch: FetchLike): Promise<Error> {
  getCfClient.mockResolvedValue(createClient({ accountId: ACC, token: TOKEN, fetch }));
  const error = await review().then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) throw new Error("the review did not fail");
  return error;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: MANAGER_WORKER,
  });
  requireRole.mockReset();
  requireRole.mockResolvedValue({ user: { id: "user-owner" }, session: { id: "s" } });
  getCfClient.mockReset();
});

describe("getRemovalReview", () => {
  it("passes on Cloudflare's answer without the container applications, with its message", async () => {
    const error = await refusal(answersWithoutList("/containers/applications"));
    expect(error.name).toBe("Error");
    expect(error.message).toBe("Cloudflare's answer for the container applications holds no list");
  });

  it("passes on Cloudflare's answer without the Durable Object namespaces, with its message", async () => {
    const error = await refusal(answersWithoutList("/workers/durable_objects/namespaces"));
    expect(error.name).toBe("Error");
    expect(error.message).toBe("the Durable Object namespaces answer holds no list");
  });

  it("leaves any other failure as it is", async () => {
    const error = await refusal(async () => {
      throw new TypeError("fetch failed");
    });
    expect(error).toBeInstanceOf(TypeError);
  });
});
