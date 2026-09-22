import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

/**
 * Manager roles. Admins manage users and change things;
 * members read everything and change nothing. Better Auth's admin plugin only
 * knows `admin` and `user` unless given an access controller, so this defines one
 * over the plugin's default statements: `admin` gets the plugin's admin
 * permissions, `member` none (like the plugin's `user`). Shared by the server
 * (`auth/server.ts`) and the client plugin (`auth/client.ts`).
 */
export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const accessControl = createAccessControl(defaultStatements);
export const roles = {
  admin: accessControl.newRole(adminAc.statements),
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
