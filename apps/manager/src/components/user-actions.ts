import type { Role } from "../auth/roles";

/**
 * What the Users table offers on a row. Client-safe. The server checks the
 * same rules again (server/users.server.ts); this only decides what to show.
 */

export type UserAction =
  | { kind: "reset" }
  | { kind: "role"; role: Role }
  | { kind: "transfer" }
  | { kind: "delete" };

export interface UserActionTarget {
  id: string;
  role: Role;
  isOwner: boolean;
}

export interface UserActionViewer {
  id: string;
  isAdmin: boolean;
  isOwner: boolean;
}

/**
 * Whether `viewer` may reset `target`'s password (send a reset link or
 * issue a recovery code): the owner, for any other user; an admin, for
 * members only. A recovery code shown to someone lets them sign in as its
 * user, so nobody gets one for a user who can do more than members, except
 * the owner. Nobody resets their own or the owner's password here; the owner
 * recovers through the Cloudflare account.
 */
export function canResetPassword(viewer: UserActionViewer, target: UserActionTarget): boolean {
  if (!viewer.isAdmin || target.id === viewer.id || target.isOwner) return false;
  return viewer.isOwner || target.role === "member";
}

/**
 * Admins may reset a member's password, the owner anyone's but their own
 * (see {@link canResetPassword}).
 * The owner may also make another user an admin or a member, transfer
 * ownership to an admin, or delete them. Nobody acts on the owner's own row
 * (ownership moves only by a transfer), and members get no actions at all.
 */
export function userActions(viewer: UserActionViewer, target: UserActionTarget): UserAction[] {
  const actions: UserAction[] = [];
  if (canResetPassword(viewer, target)) actions.push({ kind: "reset" });
  if (!viewer.isOwner || target.isOwner) return actions;
  actions.push({ kind: "role", role: target.role === "admin" ? "member" : "admin" });
  if (target.role === "admin") actions.push({ kind: "transfer" });
  actions.push({ kind: "delete" });
  return actions;
}

/** The note above the table for someone who cannot change users. */
export function readOnlyNote(owner: { name: string; email: string } | undefined): string {
  return owner === undefined
    ? "Only the owner can change roles or delete users."
    : `Only the owner, ${owner.name} (${owner.email}), can change roles or delete users.`;
}
