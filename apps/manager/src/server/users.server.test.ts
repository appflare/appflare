import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthGuardError } from "../auth/guards";
import { type Auth, createAuth } from "../auth/server";
import { createDb, type Database } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { account, featured_dismissals, passkey, session, user } from "../db/schema";
import { markSeen, readSeenVersion } from "../whats-new/seen.server";
import {
  changeUserRole,
  deleteUser,
  ensureOwner,
  isOwner,
  listManagedUsers,
  makeFirstUserOwner,
  OWNER_ONLY_MESSAGE,
  transferOwnership,
  USER_CHANGE_MESSAGES,
  UserChangeError,
} from "./users.server";

const db = (): Database => createDb(env.DB);

type Seat = "owner" | "admin" | "member";

/** Seeds a user; the owner is an admin with the flag, as setup leaves it. */
async function seedUser(id: string, seat: Seat, createdAt = new Date("2026-09-01T00:00:00Z")) {
  await db()
    .insert(user)
    .values({
      id,
      name: `User ${id}`,
      email: `${id}@example.com`,
      role: seat === "member" ? "member" : "admin",
      isOwner: seat === "owner",
      createdAt,
      updatedAt: createdAt,
    });
}

/** The standard cast: one of each, plus a second admin and a second member as targets. */
async function seedCast() {
  await seedUser("owner", "owner", new Date("2026-09-01T00:00:00Z"));
  await seedUser("admin", "admin", new Date("2026-09-02T00:00:00Z"));
  await seedUser("member", "member", new Date("2026-09-03T00:00:00Z"));
  await seedUser("admin2", "admin", new Date("2026-09-04T00:00:00Z"));
  await seedUser("member2", "member", new Date("2026-09-05T00:00:00Z"));
}

async function roleOf(id: string): Promise<string | null | undefined> {
  const [row] = await db().select({ role: user.role }).from(user).where(eq(user.id, id));
  return row?.role;
}

async function exists(id: string): Promise<boolean> {
  const rows = await db().select({ id: user.id }).from(user).where(eq(user.id, id));
  return rows.length === 1;
}

async function denied(run: Promise<unknown>): Promise<boolean> {
  try {
    await run;
    return false;
  } catch (error) {
    if (error instanceof AuthGuardError && error.status === 403) {
      expect(error.message).toBe(OWNER_ONLY_MESSAGE);
      return true;
    }
    throw error;
  }
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("authorization: only the owner changes users", () => {
  const callers: Seat[] = ["owner", "admin", "member"];

  for (const caller of callers) {
    const allowed = caller === "owner";

    it(`changeUserRole by ${caller}: ${allowed ? "allowed" : "refused"}`, async () => {
      await seedCast();
      const run = changeUserRole(db(), caller, { userId: "member2", role: "admin" });
      if (allowed) {
        await run;
        expect(await roleOf("member2")).toBe("admin");
      } else {
        expect(await denied(run)).toBe(true);
        expect(await roleOf("member2")).toBe("member");
      }
    });

    it(`deleteUser by ${caller}: ${allowed ? "allowed" : "refused"}`, async () => {
      await seedCast();
      await markSeen(db(), "member2", "0.4.0");
      const run = deleteUser(db(), caller, { userId: "member2" });
      if (allowed) {
        await run;
        expect(await exists("member2")).toBe(false);
        expect(await readSeenVersion(db(), "member2")).toBeNull();
      } else {
        expect(await denied(run)).toBe(true);
        expect(await exists("member2")).toBe(true);
        expect(await readSeenVersion(db(), "member2")).toBe("0.4.0");
      }
    });

    it(`transferOwnership by ${caller}: ${allowed ? "allowed" : "refused"}`, async () => {
      await seedCast();
      const run = transferOwnership(db(), caller, { userId: "admin2" });
      if (allowed) {
        await run;
        expect(await isOwner(db(), "admin2")).toBe(true);
      } else {
        expect(await denied(run)).toBe(true);
        expect(await isOwner(db(), "owner")).toBe(true);
        expect(await isOwner(db(), "admin2")).toBe(false);
      }
    });
  }

  it("refuses a caller who does not exist", async () => {
    await seedCast();
    expect(await denied(deleteUser(db(), "nobody", { userId: "member" }))).toBe(true);
  });

  it("follows the database, not a stale session: a former owner is refused", async () => {
    await seedCast();
    await transferOwnership(db(), "owner", { userId: "admin" });
    expect(await denied(deleteUser(db(), "owner", { userId: "member" }))).toBe(true);
    await deleteUser(db(), "admin", { userId: "member" });
    expect(await exists("member")).toBe(false);
  });
});

describe("changeUserRole", () => {
  it("demotes an admin to member and promotes back", async () => {
    await seedCast();
    expect(await changeUserRole(db(), "owner", { userId: "admin", role: "member" })).toEqual({
      email: "admin@example.com",
      before: "admin",
      after: "member",
    });
    expect(await roleOf("admin")).toBe("member");
    await changeUserRole(db(), "owner", { userId: "admin", role: "admin" });
    expect(await roleOf("admin")).toBe("admin");
  });

  it("reports no change when the role is already right", async () => {
    await seedCast();
    const change = await changeUserRole(db(), "owner", { userId: "member", role: "member" });
    expect(change.before).toBe(change.after);
  });

  it("never demotes the owner, the owner themself included", async () => {
    await seedCast();
    await expect(
      changeUserRole(db(), "owner", { userId: "owner", role: "member" }),
    ).rejects.toThrow(new UserChangeError(USER_CHANGE_MESSAGES.ownerRole));
    expect(await roleOf("owner")).toBe("admin");
  });

  it("says when the user is gone", async () => {
    await seedCast();
    await expect(changeUserRole(db(), "owner", { userId: "ghost", role: "admin" })).rejects.toThrow(
      USER_CHANGE_MESSAGES.notFound,
    );
  });
});

describe("deleteUser", () => {
  async function seedSignedInWithPasskey(userId: string) {
    const now = new Date("2026-09-20T00:00:00Z");
    await db()
      .insert(session)
      .values([
        { id: `${userId}-s1`, token: `${userId}-t1`, userId, expiresAt: now, updatedAt: now },
        { id: `${userId}-s2`, token: `${userId}-t2`, userId, expiresAt: now, updatedAt: now },
      ]);
    await db()
      .insert(passkey)
      .values({
        id: `${userId}-pk`,
        name: "Laptop",
        userId,
        publicKey: "cHVibGljLWtleQ",
        credentialID: `${userId}-cred`,
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: now,
      });
    await db()
      .insert(account)
      .values({
        id: `${userId}-acct`,
        accountId: userId,
        providerId: "credential",
        userId,
        password: "not-a-real-hash",
        updatedAt: now,
      });
    await db()
      .insert(featured_dismissals)
      .values({ user_id: userId, item_id: "sponsor-1", dismissed_at: now });
  }

  async function countFor(userId: string) {
    const d = db();
    const [s, p, a, f] = await Promise.all([
      d.select().from(session).where(eq(session.userId, userId)),
      d.select().from(passkey).where(eq(passkey.userId, userId)),
      d.select().from(account).where(eq(account.userId, userId)),
      d.select().from(featured_dismissals).where(eq(featured_dismissals.user_id, userId)),
    ]);
    return { sessions: s.length, passkeys: p.length, accounts: a.length, dismissals: f.length };
  }

  it("removes the user's sessions, passkeys, password and dismissals, and nobody else's", async () => {
    await seedCast();
    await seedSignedInWithPasskey("admin");
    await seedSignedInWithPasskey("member");

    expect(await deleteUser(db(), "owner", { userId: "admin" })).toEqual({
      email: "admin@example.com",
      wasAdmin: true,
    });

    expect(await exists("admin")).toBe(false);
    expect(await countFor("admin")).toEqual({
      sessions: 0,
      passkeys: 0,
      accounts: 0,
      dismissals: 0,
    });
    expect(await countFor("member")).toEqual({
      sessions: 2,
      passkeys: 1,
      accounts: 1,
      dismissals: 1,
    });
  });

  it("reports a deleted member as not an admin", async () => {
    await seedCast();
    expect((await deleteUser(db(), "owner", { userId: "member" })).wasAdmin).toBe(false);
  });

  it("refuses to delete the owner", async () => {
    await seedCast();
    await expect(deleteUser(db(), "owner", { userId: "owner" })).rejects.toThrow(
      USER_CHANGE_MESSAGES.deleteOwner,
    );
    expect(await exists("owner")).toBe(true);
  });

  it("two tabs: a delete from a page loaded before a transfer changes nothing", async () => {
    await seedCast();
    await seedSignedInWithPasskey("member");
    // Tab A hands ownership over; tab B, still showing the owner's menu, deletes.
    await transferOwnership(db(), "owner", { userId: "admin" });
    expect(await denied(deleteUser(db(), "owner", { userId: "member" }))).toBe(true);
    expect(await exists("member")).toBe(true);
    expect(await countFor("member")).toEqual({
      sessions: 2,
      passkeys: 1,
      accounts: 1,
      dismissals: 1,
    });
  });
});

describe("transferOwnership", () => {
  it("moves ownership to an admin; the previous owner stays an admin", async () => {
    await seedCast();
    await transferOwnership(db(), "owner", { userId: "admin2" });
    const users = await listManagedUsers(db());
    expect(users.filter((u) => u.isOwner).map((u) => u.id)).toEqual(["admin2"]);
    expect(users.find((u) => u.id === "owner")).toMatchObject({ role: "admin", isOwner: false });
  });

  it("refuses a member; they must be made an admin first", async () => {
    await seedCast();
    await expect(transferOwnership(db(), "owner", { userId: "member" })).rejects.toThrow(
      USER_CHANGE_MESSAGES.transferToMember,
    );
    expect(await isOwner(db(), "owner")).toBe(true);
  });

  it("refuses the owner themself and a missing user", async () => {
    await seedCast();
    await expect(transferOwnership(db(), "owner", { userId: "owner" })).rejects.toThrow(
      USER_CHANGE_MESSAGES.alreadyOwner,
    );
    await expect(transferOwnership(db(), "owner", { userId: "ghost" })).rejects.toThrow(
      USER_CHANGE_MESSAGES.notFound,
    );
    expect(await isOwner(db(), "owner")).toBe(true);
  });

  it("lets the new owner act and hand it back", async () => {
    await seedCast();
    await transferOwnership(db(), "owner", { userId: "admin" });
    await transferOwnership(db(), "admin", { userId: "owner" });
    expect(await isOwner(db(), "owner")).toBe(true);
    expect(await isOwner(db(), "admin")).toBe(false);
  });
});

describe("the single owner", () => {
  it("heals a manager without an owner: the first owner check promotes the earliest admin", async () => {
    await seedUser("member", "member", new Date("2026-09-01T00:00:00Z"));
    await seedUser("admin-late", "admin", new Date("2026-09-03T00:00:00Z"));
    await seedUser("admin-first", "admin", new Date("2026-09-02T00:00:00Z"));
    expect((await db().select().from(user)).some((u) => u.isOwner === true)).toBe(false);

    await changeUserRole(db(), "admin-first", { userId: "member", role: "admin" });
    expect(await isOwner(db(), "admin-first")).toBe(true);
    expect(await roleOf("member")).toBe("admin");
    expect(await denied(deleteUser(db(), "admin-late", { userId: "member" }))).toBe(true);
  });

  it("heals when the users are listed, and never moves an existing owner", async () => {
    await seedUser("admin-first", "admin", new Date("2026-09-01T00:00:00Z"));
    await seedUser("admin-late", "admin", new Date("2026-09-02T00:00:00Z"));
    expect((await listManagedUsers(db())).filter((u) => u.isOwner).map((u) => u.id)).toEqual([
      "admin-first",
    ]);
    await transferOwnership(db(), "admin-first", { userId: "admin-late" });
    await ensureOwner(db());
    expect((await listManagedUsers(db())).filter((u) => u.isOwner).map((u) => u.id)).toEqual([
      "admin-late",
    ]);
  });

  it("makeFirstUserOwner names the setup user and never a second owner", async () => {
    await seedUser("first", "admin");
    await seedUser("second", "admin");
    await makeFirstUserOwner(db(), "first");
    await makeFirstUserOwner(db(), "second");
    expect(await isOwner(db(), "first")).toBe(true);
    expect(await isOwner(db(), "second")).toBe(false);
  });

  it("the database refuses a second owner", async () => {
    await seedUser("owner", "owner");
    await seedUser("admin", "admin");
    await expect(
      db().update(user).set({ isOwner: true }).where(eq(user.id, "admin")),
    ).rejects.toThrow();
  });

  it("the migration makes the earliest admin the owner of an existing manager", async () => {
    await reset();
    const before = migrations.findIndex((m) => m.tag === "0014_owner");
    await createMigrator(migrations.slice(0, before)).ensure(env.DB);
    const insert = env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?1, ?1, ?2, 0, ?3, ?4, ?4)",
    );
    await env.DB.batch([
      insert.bind("m-early", "m@example.com", "member", 1_000),
      insert.bind("a-late", "late@example.com", "admin", 3_000),
      insert.bind("a-first", "first@example.com", "admin", 2_000),
    ]);
    await createMigrator(migrations).ensure(env.DB);
    const owners = (await listManagedUsers(db())).filter((u) => u.isOwner).map((u) => u.id);
    expect(owners).toEqual(["a-first"]);
  });
});

describe("Better Auth's admin endpoints", () => {
  const BASE = "https://appflare.appflare-dev.workers.dev";
  const PASSWORD = "correct horse battery staple";

  function auth(): Auth {
    return createAuth({
      db: db(),
      secret: "test-only-better-auth-secret-0000000000000",
      baseURL: BASE,
    });
  }

  async function signIn(a: Auth, email: string): Promise<Headers> {
    const { headers } = await a.api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return new Headers({ cookie, origin: BASE, "content-type": "application/json" });
  }

  function post(a: Auth, headers: Headers, path: string, body: unknown) {
    return a.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  it("refuse an admin every write around the owner-only checks", async () => {
    const a = auth();
    const { user: owner } = await a.api.createUser({
      body: { email: "owner@example.com", name: "Owner", password: PASSWORD, role: "admin" },
    });
    await makeFirstUserOwner(db(), owner.id);
    await a.api.createUser({
      body: { email: "admin@example.com", name: "Admin", password: PASSWORD, role: "admin" },
    });
    const headers = await signIn(a, "admin@example.com");

    const attempts: [string, unknown][] = [
      ["/admin/set-role", { userId: owner.id, role: "member" }],
      ["/admin/remove-user", { userId: owner.id }],
      ["/admin/set-user-password", { userId: owner.id, newPassword: "another long password" }],
      ["/admin/update-user", { userId: owner.id, data: { email: "mine@example.com" } }],
      ["/admin/impersonate-user", { userId: owner.id }],
      ["/admin/ban-user", { userId: owner.id }],
      ["/admin/revoke-user-sessions", { userId: owner.id }],
      [
        "/admin/create-user",
        { email: "x@example.com", name: "X", password: PASSWORD, role: "admin" },
      ],
    ];
    for (const [path, body] of attempts) {
      const response = await post(a, headers, path, body);
      expect(response.status, path).toBe(403);
    }
    expect(await roleOf(owner.id)).toBe("admin");
    expect(await isOwner(db(), owner.id)).toBe(true);
  });

  it("refuse anyone setting the owner flag on themselves", async () => {
    const a = auth();
    await a.api.createUser({
      body: { email: "admin@example.com", name: "Admin", password: PASSWORD, role: "admin" },
    });
    const headers = await signIn(a, "admin@example.com");
    const response = await post(a, headers, "/update-user", { isOwner: true });
    expect(response.status).toBe(400);
    const [row] = await db().select({ isOwner: user.isOwner }).from(user);
    expect(row?.isOwner).toBe(false);
  });

  it("still let an admin list users", async () => {
    const a = auth();
    await a.api.createUser({
      body: { email: "admin@example.com", name: "Admin", password: PASSWORD, role: "admin" },
    });
    const headers = await signIn(a, "admin@example.com");
    const list = await a.handler(
      new Request(`${BASE}/api/auth/admin/list-users`, { method: "GET", headers }),
    );
    expect(list.status).toBe(200);
  });
});
