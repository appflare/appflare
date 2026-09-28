import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import { type GateInputs, readGate } from "./gate.server";

const member = {
  user: { id: "u2", email: "m@example.com", name: "M", role: "member", isOwner: false },
};

function inputs(over: Partial<GateInputs> = {}): GateInputs {
  return {
    db: env.DB,
    loadSession: async () => null,
    setupClaimed: async () => {
      throw new Error("the claim is read only before the owner exists");
    },
    authReady: true,
    ...over,
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("readGate", () => {
  it("before anything is set up: no user, no token, and the claim is not asked", async () => {
    const read = await readGate(inputs());
    expect(read.state).toEqual({
      hasUser: false,
      signedIn: false,
      isAdmin: false,
      tokenConfigured: false,
      setupClaimed: false,
      authReady: true,
    });
    expect(read.viewer).toBeNull();
    expect(read.accountId).toBeNull();
  });

  it("asks for the setup claim once the token is in and no owner exists", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.cfTokenConfigured]: "1" });
    const read = await readGate(inputs({ setupClaimed: async () => true }));
    expect(read.state.tokenConfigured).toBe(true);
    expect(read.state.setupClaimed).toBe(true);
  });

  it("reads the viewer, the token and the account for a signed-in member", async () => {
    await createDb(env.DB)
      .insert(user)
      .values({
        id: "u1",
        name: "Owner",
        email: "o@example.com",
        role: "admin",
        isOwner: true,
        createdAt: new Date(1),
        updatedAt: new Date(1),
      });
    await writeSettings(createDb(env.DB), {
      [SETTING.cfTokenConfigured]: "1",
      [SETTING.accountId]: "acc1",
    });
    const read = await readGate(inputs({ loadSession: async () => member }));
    expect(read.state).toMatchObject({ hasUser: true, signedIn: true, isAdmin: false });
    expect(read.viewer).toEqual({
      id: "u2",
      email: "m@example.com",
      name: "M",
      role: "member",
      isOwner: false,
    });
    expect(read.accountId).toBe("acc1");
  });
});
