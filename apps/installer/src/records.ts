import { and, eq, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { type InstallationRow, installations, type NewInstallationRow } from "./db/schema";
import { InstallerError } from "./http";
import { base64url } from "./proof";

/**
 * Installation records: create, read, change, and the lease that lets only
 * one request work on a record at a time (two open tabs, a double click).
 * The key the deploy page keeps is returned once and stored as its sha256.
 */

export type Database = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema: { installations } });
}

export type InstallationStatus = "running" | "waiting" | "deployed" | "failed" | "removing";

/** A new key: 32 random bytes, 43 base64url characters. */
export function newKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether `key` is the record's key (compared as hashes, in constant time). */
export async function keyMatches(record: InstallationRow, key: string): Promise<boolean> {
  const enc = new TextEncoder();
  const given = enc.encode(await hashKey(key));
  const stored = enc.encode(record.key_hash);
  return given.byteLength === stored.byteLength && crypto.subtle.timingSafeEqual(given, stored);
}

export const NOT_FOUND = new InstallerError(
  404,
  "not_found",
  "This installation is not known here any more. It may have finished or been removed.",
);

export async function getRecord(db: Database, id: string): Promise<InstallationRow> {
  const row = await db.query.installations.findFirst({ where: eq(installations.id, id) });
  if (row === undefined) throw NOT_FOUND;
  return row;
}

/** The record, after checking `key`; a wrong key reads like a missing record would not. */
export async function recordWithKey(
  db: Database,
  id: string,
  key: string,
): Promise<InstallationRow> {
  const row = await getRecord(db, id);
  if (!(await keyMatches(row, key))) {
    throw new InstallerError(
      403,
      "wrong_key",
      "This browser's key for the installation does not match.",
    );
  }
  return row;
}

export async function listForAccount(db: Database, accountId: string): Promise<InstallationRow[]> {
  return db.query.installations.findMany({
    where: eq(installations.account_id, accountId),
    orderBy: (t, { asc }) => [asc(t.created_at)],
  });
}

/** Inserts a record; a second one for the same account and Worker name is refused. */
export async function insertRecord(db: Database, row: NewInstallationRow): Promise<void> {
  try {
    await db.insert(installations).values(row);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(`${error.message} ${String(error.cause ?? "")}`)
    ) {
      throw new InstallerError(
        409,
        "name_taken",
        `There is already an unfinished installation named "${row.worker_name}" in this account. Continue or remove it instead.`,
      );
    }
    throw error;
  }
}

export type RecordPatch = Partial<Omit<InstallationRow, "id" | "created_at">>;

export async function updateRecord(
  db: Database,
  id: string,
  patch: RecordPatch,
  now: number,
): Promise<void> {
  await db
    .update(installations)
    .set({ ...patch, updated_at: now })
    .where(eq(installations.id, id));
}

export async function deleteRecord(db: Database, id: string): Promise<boolean> {
  const deleted = await db
    .delete(installations)
    .where(eq(installations.id, id))
    .returning({ id: installations.id });
  return deleted.length > 0;
}

/** A step or cleanup request never runs longer than this; a crashed one frees the record after it. */
export const LEASE_MS = 60_000;

/** Takes the record for one request; false when another request holds it. */
export async function acquireLease(
  db: Database,
  id: string,
  owner: string,
  now: number,
): Promise<boolean> {
  const taken = await db
    .update(installations)
    .set({ lease_owner: owner, lease_until: now + LEASE_MS })
    .where(
      and(
        eq(installations.id, id),
        or(isNull(installations.lease_until), lt(installations.lease_until, now)),
      ),
    )
    .returning({ id: installations.id });
  return taken.length > 0;
}

export async function releaseLease(db: Database, id: string, owner: string): Promise<void> {
  await db
    .update(installations)
    .set({ lease_owner: null, lease_until: null })
    .where(and(eq(installations.id, id), eq(installations.lease_owner, owner)));
}
