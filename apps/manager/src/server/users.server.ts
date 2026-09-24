import { and, asc, count, eq, sql } from "drizzle-orm";
import { AuthGuardError } from "../auth/guards";
import { hasRole, type Role } from "../auth/roles";
import type { Database } from "../db/client";
import { user } from "../db/schema";

/** True once any user exists: from then on `/setup` no longer creates admins. */
export async function hasAnyUser(db: Database): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(user);
  return (row?.n ?? 0) > 0;
}

/** Better Auth's `APIError` carries a user-facing message in `body.message`. */
export function authErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "body" in error) {
    const body = (error as { body?: { message?: unknown } }).body;
    if (typeof body?.message === "string" && body.message.length > 0) return body.message;
  }
  return fallback;
}

/*
 * The owner and user management.
 *
 * The first user, created at setup, is the owner: an admin with
 * `user.is_owner` set (a unique partial index keeps it to one user). Only the
 * owner changes roles, deletes users, and transfers ownership; admins keep
 * everything else, adding users included. The owner is never demoted or
 * deleted: ownership moves only by an explicit transfer to another admin, and
 * the previous owner stays an admin.
 *
 * Every function here takes the caller's user id and checks, against the
 * database rather than the session, that the caller is the owner. The server
 * functions in `users.functions.ts` require an admin session first.
 */

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isOwner: boolean;
  createdAt: Date;
}

export const OWNER_ONLY_MESSAGE =
  "Only the owner can change roles, delete users, or transfer ownership.";

/** A refused change the owner can act on; its message is shown as is. */
export class UserChangeError extends Error {
  override name = "UserChangeError";
}

export const USER_CHANGE_MESSAGES = {
  notFound: "That user no longer exists. Reload the page.",
  ownerRole:
    "The owner is always an admin. To step down, transfer ownership to another admin first.",
  deleteOwner: "The owner cannot be deleted. Transfer ownership to another admin first.",
  deleteNotAllowed:
    "That user can no longer be deleted: ownership or the user changed meanwhile. Reload the page.",
  alreadyOwner: "You are already the owner.",
  transferToMember: "Ownership can only go to an admin. Make them an admin first.",
  transferFailed: "Ownership did not change. Reload the page and try again.",
} as const;

/** SQL twin of `hasRole(role, "admin")` for Better Auth's comma-separated roles. */
const holdsAdmin = sql`(',' || replace(coalesce(${user.role}, ''), ' ', '') || ',') LIKE '%,admin,%'`;

function toManagedUser(row: {
  id: string;
  email: string;
  name: string;
  role: string | null;
  isOwner: boolean | null;
  createdAt: Date;
}): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: hasRole(row.role, "admin") ? "admin" : "member",
    isOwner: row.isOwner === true,
    createdAt: row.createdAt,
  };
}

const managedUserColumns = {
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  isOwner: user.isOwner,
  createdAt: user.createdAt,
};

/**
 * Self-healing: when no owner exists (a failed write at setup, a database
 * edited by hand), the earliest admin becomes the owner, as the migration
 * that introduced owners did. Idempotent, and a no-op once an owner exists.
 */
export async function ensureOwner(db: Database): Promise<void> {
  await db
    .update(user)
    .set({ isOwner: true })
    .where(
      and(
        sql`${user.id} = (SELECT "first"."id" FROM "user" AS "first" WHERE (',' || replace(coalesce("first"."role", ''), ' ', '') || ',') LIKE '%,admin,%' ORDER BY "first"."created_at" ASC, "first"."id" ASC LIMIT 1)`,
        sql`NOT EXISTS (SELECT 1 FROM "user" AS "owner" WHERE "owner"."is_owner" = 1)`,
      ),
    );
}

/** Every user, oldest first (after {@link ensureOwner}, so the list always shows an owner). */
export async function listManagedUsers(db: Database): Promise<ManagedUser[]> {
  await ensureOwner(db);
  const rows = await db
    .select(managedUserColumns)
    .from(user)
    .orderBy(asc(user.createdAt), asc(user.id));
  return rows.map(toManagedUser);
}

async function findUser(db: Database, userId: string): Promise<ManagedUser | null> {
  const [row] = await db.select(managedUserColumns).from(user).where(eq(user.id, userId)).limit(1);
  return row === undefined ? null : toManagedUser(row);
}

/** Whether `userId` is the owner. */
export async function isOwner(db: Database, userId: string): Promise<boolean> {
  return (await findUser(db, userId))?.isOwner === true;
}

async function requireOwner(db: Database, actorId: string): Promise<ManagedUser> {
  await ensureOwner(db);
  const actor = await findUser(db, actorId);
  if (actor === null || !actor.isOwner) throw new AuthGuardError(403, OWNER_ONLY_MESSAGE);
  return actor;
}

async function requireUser(db: Database, userId: string): Promise<ManagedUser> {
  const target = await findUser(db, userId);
  if (target === null) throw new UserChangeError(USER_CHANGE_MESSAGES.notFound);
  return target;
}

/**
 * Makes the user created at setup the owner. A no-op when an owner already
 * exists, so it can never name a second one.
 */
export async function makeFirstUserOwner(db: Database, userId: string): Promise<void> {
  await db
    .update(user)
    .set({ isOwner: true })
    .where(and(eq(user.id, userId), sql`NOT EXISTS (SELECT 1 FROM "user" WHERE "is_owner" = 1)`));
}

export interface RoleChange {
  email: string;
  before: Role;
  after: Role;
}

/** Owner only: makes another user an admin or a member. */
export async function changeUserRole(
  db: Database,
  actorId: string,
  input: { userId: string; role: Role },
): Promise<RoleChange> {
  await requireOwner(db, actorId);
  const target = await requireUser(db, input.userId);
  if (target.isOwner) throw new UserChangeError(USER_CHANGE_MESSAGES.ownerRole);
  if (target.role !== input.role) {
    await db
      .update(user)
      .set({ role: input.role })
      .where(and(eq(user.id, target.id), sql`coalesce(${user.isOwner}, 0) = 0`));
  }
  return { email: target.email, before: target.role, after: input.role };
}

export interface DeletedUser {
  email: string;
  wasAdmin: boolean;
}

/**
 * Owner only: deletes another user with everything tied to them: their
 * sessions (so they are signed out on their next request), passkeys, password,
 * and hidden sponsored items. Appflare sends no invitations, so there are none
 * to withdraw. Apps, jobs and settings do not belong to a user and stay.
 *
 * One statement, all or nothing: it deletes the user only if they are not the
 * owner and the caller still is at that moment (another tab may have
 * transferred ownership since the checks above). Sessions, accounts, passkeys
 * and dismissals go with the user through their `ON DELETE CASCADE` foreign
 * keys, which D1 enforces.
 */
export async function deleteUser(
  db: Database,
  actorId: string,
  input: { userId: string },
): Promise<DeletedUser> {
  await requireOwner(db, actorId);
  const target = await requireUser(db, input.userId);
  if (target.isOwner) throw new UserChangeError(USER_CHANGE_MESSAGES.deleteOwner);
  const deleted = await db
    .delete(user)
    .where(
      and(
        eq(user.id, target.id),
        sql`coalesce(${user.isOwner}, 0) = 0`,
        sql`EXISTS (SELECT 1 FROM "user" AS "caller" WHERE "caller"."id" = ${actorId} AND "caller"."is_owner" = 1)`,
      ),
    )
    .returning({ id: user.id });
  if (deleted.length === 0) throw new UserChangeError(USER_CHANGE_MESSAGES.deleteNotAllowed);
  return { email: target.email, wasAdmin: target.role === "admin" };
}

/**
 * Owner only: hands ownership to another admin. The caller stays an admin.
 * Both writes run in one transaction, and each is conditional so that a
 * target that vanished or stopped being an admin leaves the owner unchanged
 * rather than leaving no owner.
 */
export async function transferOwnership(
  db: Database,
  actorId: string,
  input: { userId: string },
): Promise<{ email: string }> {
  const actor = await requireOwner(db, actorId);
  const target = await requireUser(db, input.userId);
  if (target.id === actor.id) throw new UserChangeError(USER_CHANGE_MESSAGES.alreadyOwner);
  if (target.role !== "admin") throw new UserChangeError(USER_CHANGE_MESSAGES.transferToMember);
  await db.batch([
    db
      .update(user)
      .set({ isOwner: false, role: "admin" })
      .where(
        and(
          eq(user.id, actor.id),
          eq(user.isOwner, true),
          sql`EXISTS (SELECT 1 FROM "user" AS "target" WHERE "target"."id" = ${target.id} AND (',' || replace(coalesce("target"."role", ''), ' ', '') || ',') LIKE '%,admin,%')`,
        ),
      ),
    db
      .update(user)
      .set({ isOwner: true })
      .where(
        and(
          eq(user.id, target.id),
          holdsAdmin,
          sql`NOT EXISTS (SELECT 1 FROM "user" AS "owner" WHERE "owner"."is_owner" = 1)`,
        ),
      ),
  ]);
  if (!(await isOwner(db, target.id))) {
    throw new UserChangeError(USER_CHANGE_MESSAGES.transferFailed);
  }
  return { email: target.email };
}
