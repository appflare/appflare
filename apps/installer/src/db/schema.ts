import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One row per unfinished browser installation of Appflare: what the hosted
 * installer needs to continue, recover or remove it. It never holds a token,
 * anything about the owner, or app data. `key_hash` is the sha256 of the key
 * the deploy page keeps; `handoff_hash` is the sha256 the new manager holds
 * (the deploy page alone knows the secret behind it). A row lives until the
 * manager reports its owner is set up, or someone removes the installation;
 * there is no time-based expiry.
 */
export const installations = sqliteTable(
  "installations",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id").notNull(),
    worker_name: text("worker_name").notNull(),
    /** The custom domain asked for; null for the workers.dev address. */
    hostname: text("hostname"),
    zone_id: text("zone_id"),
    /** Where the manager is opened: `https://<hostname>` or its workers.dev URL. */
    address: text("address").notNull(),
    /** The account's workers.dev subdomain when the installation was made; null when it had none. */
    workers_dev_subdomain: text("workers_dev_subdomain"),

    release_version: text("release_version").notNull(),
    /** sha256 hex of the exact `manifest.json` bytes, whose signature was checked. */
    release_digest: text("release_digest").notNull(),
    /** The exact `manifest.json` text (verified again against the digest on every read). */
    release_manifest: text("release_manifest").notNull(),
    release_zip_url: text("release_zip_url").notNull(),
    release_key_id: text("release_key_id").notNull(),

    key_hash: text("key_hash").notNull(),
    handoff_hash: text("handoff_hash").notNull(),

    /** `running`, `waiting`, `deployed`, `failed` or `removing`. */
    status: text("status").notNull(),
    /** The deploy step it is on (deploy/steps.ts). */
    step: text("step").notNull(),
    /** The last progress or failure message, in plain words. */
    message: text("message"),

    // What the installation created (and only that is ever removed), with the
    // time each create was attempted: a create whose answer was lost is
    // recognised by a resource of that name made after the attempt.
    d1_name: text("d1_name").notNull(),
    d1_id: text("d1_id"),
    d1_attempt_at: integer("d1_attempt_at"),
    kv_title: text("kv_title").notNull(),
    kv_id: text("kv_id"),
    kv_attempt_at: integer("kv_attempt_at"),
    worker_created: integer("worker_created", { mode: "boolean" }).notNull().default(false),
    worker_attempt_at: integer("worker_attempt_at"),
    workflow_name: text("workflow_name").notNull(),
    workflow_created: integer("workflow_created", { mode: "boolean" }).notNull().default(false),
    domain_id: text("domain_id"),

    /** Times the asset upload went back for files Cloudflare asked for again. */
    asset_rounds: integer("asset_rounds").notNull().default(0),
    /** Checks of the address so far, for the wait between them. */
    proof_attempts: integer("proof_attempts").notNull().default(0),

    /** Who is working on the row now and until when (epoch ms); one request at a time. */
    lease_owner: text("lease_owner"),
    lease_until: integer("lease_until"),

    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    index("installations_account").on(t.account_id),
    // One unfinished installation per Worker name and account: a second
    // deploy of the same name is refused instead of racing the first.
    uniqueIndex("installations_account_worker").on(t.account_id, t.worker_name),
  ],
);

export type InstallationRow = typeof installations.$inferSelect;
export type NewInstallationRow = typeof installations.$inferInsert;
