import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import type { Role } from "../auth/roles";
import { generateTemporaryPassword } from "../auth/temporary-password";
import { createDb } from "../db/client";
import { syncAccessAfterAdminChange } from "./access.server";
import { currentAuth, requireRole } from "./auth.server";
import { addUserInput, changeUserRoleInput, userIdInput } from "./schemas";
import {
  authErrorMessage,
  changeUserRole as changeRole,
  deleteUser as deleteManagedUser,
  listManagedUsers,
  type ManagedUser,
  transferOwnership as transferOwner,
} from "./users.server";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** The one admin who changes roles, deletes users and transfers ownership. */
  isOwner: boolean;
  /** ISO 8601 */
  createdAt: string;
}

/** Whether the Cloudflare Access allow policy followed a change to the admins. */
export type AccessPolicyOutcome = "off" | "updated" | "failed";

function toRow(u: ManagedUser): UserRow {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isOwner: u.isOwner,
    createdAt: u.createdAt.toISOString(),
  };
}

/** Admin only: every manager user (settings, "Users"), oldest first. */
export const listUsers = createServerFn({ method: "GET" }).handler(async (): Promise<UserRow[]> => {
  await requireRole("admin");
  return (await listManagedUsers(createDb(env.DB))).map(toRow);
});

/**
 * Admin only: creates a user with a random temporary password, returned once so
 * the dialog can show it. The password is never stored in plain
 * text or logged. The guard above is the permission check: Better Auth's own
 * admin endpoints no longer let an admin set a role (auth/roles.ts), so the
 * user is created as a trusted server call, without the request's headers.
 */
export const addUser = createServerFn({ method: "POST" })
  .validator(addUserInput)
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    const temporaryPassword = generateTemporaryPassword();
    let created: { email: string; role: Role };
    try {
      const { user } = await currentAuth().api.createUser({
        body: { email: data.email, name: data.name, role: data.role, password: temporaryPassword },
      });
      created = { email: user.email, role: data.role };
    } catch (error) {
      throw new Error(authErrorMessage(error, "Could not create the user."));
    }
    // With Cloudflare Access protection on, a new admin must also be in its
    // allow policy, or Access keeps them out before they reach the sign-in page.
    const accessPolicy: AccessPolicyOutcome =
      created.role === "admin" ? await syncAccessAfterAdminChange(session.user.email) : "off";
    return { user: created, temporaryPassword, accessPolicy };
  });

/**
 * Owner only: makes another user an admin or a member. The change applies
 * on their next request. With Cloudflare Access on, the allow policy follows.
 */
export const changeUserRole = createServerFn({ method: "POST" })
  .validator(changeUserRoleInput)
  .handler(async ({ data }): Promise<{ accessPolicy: AccessPolicyOutcome }> => {
    const session = await requireRole("admin");
    const change = await changeRole(createDb(env.DB), session.user.id, data);
    const accessPolicy: AccessPolicyOutcome =
      change.before !== change.after ? await syncAccessAfterAdminChange(session.user.email) : "off";
    return { accessPolicy };
  });

/**
 * Owner only: deletes another user, their sessions and passkeys included, so
 * they are signed out at once. With Cloudflare Access on, a deleted admin
 * leaves the allow policy.
 */
export const deleteUser = createServerFn({ method: "POST" })
  .validator(userIdInput)
  .handler(async ({ data }): Promise<{ accessPolicy: AccessPolicyOutcome }> => {
    const session = await requireRole("admin");
    const deleted = await deleteManagedUser(createDb(env.DB), session.user.id, data);
    const accessPolicy: AccessPolicyOutcome = deleted.wasAdmin
      ? await syncAccessAfterAdminChange(session.user.email)
      : "off";
    return { accessPolicy };
  });

/**
 * Owner only: hands ownership to another admin; the caller stays an admin.
 * Both are admins before and after, so the Access policy does not change.
 */
export const transferOwnership = createServerFn({ method: "POST" })
  .validator(userIdInput)
  .handler(async ({ data }) => {
    const session = await requireRole("admin");
    await transferOwner(createDb(env.DB), session.user.id, data);
    return { ok: true as const };
  });
