import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Database = DrizzleD1Database<typeof schema>;

/** Drizzle over the manager's D1 binding. Cheap; build one per request. */
export function createDb(d1: D1Database): Database {
  return drizzle(d1, { schema });
}
