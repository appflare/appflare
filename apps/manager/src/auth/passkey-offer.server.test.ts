import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { endPasskeyOffer, passkeyOfferDue } from "./passkey-offer.server";

const HOST = "appflare.example.com";
const NOW = new Date("2026-10-07T12:00:00.000Z");

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.managerHostname]: HOST,
    [SETTING.managerPreviousHostname]: "appflare.ada.workers.dev",
    [SETTING.managerMovedAt]: "2026-10-07T10:00:00.000Z",
  });
});

const due = (over: Partial<Parameters<typeof passkeyOfferDue>[1]> = {}) =>
  passkeyOfferDue(env.DB, {
    userId: "u1",
    host: HOST,
    now: NOW,
    passkeyWorksHere: false,
    ...over,
  });

describe("the passkey offer after a move", () => {
  it("is due once per user at the new address, until they add one or say Not now", async () => {
    expect(await due()).toBe(true);
    // Not chosen yet: still due at the next sign-in.
    expect(await due()).toBe(true);
    await endPasskeyOffer(env.DB, { userId: "u1", host: HOST, now: NOW });
    expect(await due()).toBe(false);
    // Another user still gets it.
    expect(await due({ userId: "u2" })).toBe(true);
  });

  it("is not due when a passkey works here, elsewhere, or long after the move", async () => {
    expect(await due({ passkeyWorksHere: true })).toBe(false);
    expect(await due({ host: "appflare.ada.workers.dev" })).toBe(false);
    expect(await due({ now: new Date("2026-11-30T00:00:00.000Z") })).toBe(false);
  });

  it("comes again after a later move to another address", async () => {
    await endPasskeyOffer(env.DB, { userId: "u1", host: HOST, now: NOW });
    await writeSettings(createDb(env.DB), {
      [SETTING.managerHostname]: "manage.example.org",
      [SETTING.managerPreviousHostname]: HOST,
    });
    expect(await due({ host: "manage.example.org" })).toBe(true);
  });
});
