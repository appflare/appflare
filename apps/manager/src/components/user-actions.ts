import type { Role } from "../auth/roles";

/**
 * What the Users table offers on a row. Client-safe. The server checks the
 * same rules again (server/users.server.ts); this only decides what to show.
 */

export type UserAction = { kind: "role"; role: Role } | { kind: "transfer" } | { kind: "delete" };

export interface UserActionTarget {
  id: string;
  role: Role;
  isOwner: boolean;
}

/**
 * The owner may make another user an admin or a member, transfer ownership
 * to an admin, or delete them. Nobody acts on the owner's own row (ownership
 * moves only by a transfer), and admins and members get no actions at all.
 */
export function userActions(viewerIsOwner: boolean, target: UserActionTarget): UserAction[] {
  if (!viewerIsOwner || target.isOwner) return [];
  const actions: UserAction[] = [
    { kind: "role", role: target.role === "admin" ? "member" : "admin" },
  ];
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
