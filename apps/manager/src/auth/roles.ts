import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

/**
 * Manager roles. Admins change things and add users; members read everything
 * and change nothing. One admin is also the owner (`user.is_owner`), the only
 * one who can change roles, delete users, hand ownership over, or reset an
 * admin's password (admins reset members' passwords only; see
 * `canResetPassword` in components/user-actions.ts). That is a
 * flag rather than a third role, so every admin check keeps holding for the
 * owner. Shared by the server (`auth/server.ts`) and the client plugin
 * (`auth/client.ts`).
 *
 * Better Auth's admin plugin only knows `admin` and `user` unless given an
 * access controller, so this defines one over the plugin's default statements.
 * `admin` may only read users there: the plugin's own endpoints under
 * `/api/auth/admin/*` would otherwise let any admin set roles, delete users,
 * set passwords, change emails or impersonate someone, the owner included,
 * around the owner-only checks. The manager creates users and changes roles
 * itself, in server functions that check the caller first
 * (`server/users.functions.ts`).
 */
export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const accessControl = createAccessControl(defaultStatements);
export const roles = {
  admin: accessControl.newRole({ user: ["list", "get"], session: [] }),
  member: accessControl.newRole({ user: [], session: [] }),
};

export const DEFAULT_ROLE: Role = "member";

/**
 * Whether a Better Auth role value (possibly comma-separated, possibly absent)
 * satisfies `required`. Admin implies member.
 */
export function hasRole(userRole: string | null | undefined, required: Role): boolean {
  const held = (userRole ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (held.includes("admin")) return true;
  return required === "member" && held.includes("member");
}
