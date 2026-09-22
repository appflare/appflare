import { count } from "drizzle-orm";
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
