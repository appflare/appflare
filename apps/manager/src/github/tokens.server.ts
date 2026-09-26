import { githubTokenSecretName, type SandboxInfo } from "@appflare/schema";
import { asc, count, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { github_tokens } from "../db/schema";
import { usesGithubTokens } from "../sandbox/binding";
import { activeSandboxJob, sandboxBusyMessage } from "../sandbox/busy";
import { ENABLE_SANDBOX_PLACE, UPDATE_SANDBOX_HINT } from "../sandbox/connect-copy";
import { type AddGithubTokenInput, addGithubTokenInput, type GithubTokenView } from "./tokens";

/**
 * GitHub access tokens, stored the way self-deploying apps' tokens are: the
 * value goes straight to a secret on the sandbox Worker
 * (`GITHUB_TOKEN_<id>`), written with the manager's Cloudflare token, and
 * this database records only the id, the label, the repositories the admin
 * says it covers, whether it serves release downloads, and when it was last
 * used. Nothing can read the value back; it is never shown again.
 *
 * Adding a token needs sandbox builds on: the sandbox Worker is where tokens
 * live and where private repositories are cloned. Disabling sandbox builds
 * deletes that Worker with every token, and the rows with it.
 */

export class GithubTokenError extends Error {
  override name = "GithubTokenError";
}

export interface GithubTokenRecord {
  id: string;
  label: string;
  repositories: string;
  forReleases: boolean;
  /** ms since the epoch. */
  createdAt: number;
  lastUsedAt: number | null;
}

/** Every token's record, oldest first. */
export async function readGithubTokens(db: D1Database): Promise<GithubTokenRecord[]> {
  const rows = await createDb(db)
    .select()
    .from(github_tokens)
    .orderBy(asc(github_tokens.created_at), asc(github_tokens.id));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    repositories: row.repositories,
    forReleases: row.for_releases,
    createdAt: row.created_at.getTime(),
    lastUsedAt: row.last_used_at?.getTime() ?? null,
  }));
}

/** The list as the settings card shows it. */
export function githubTokenViews(records: readonly GithubTokenRecord[]): GithubTokenView[] {
  return records.map((r) => ({
    id: r.id,
    label: r.label,
    repositories: r.repositories,
    forReleases: r.forReleases,
    createdAt: new Date(r.createdAt).toISOString(),
    lastUsedAt: r.lastUsedAt === null ? null : new Date(r.lastUsedAt).toISOString(),
  }));
}

/** How many tokens there are (usage data sends this count, nothing else about them). */
export async function githubTokenCount(db: D1Database): Promise<number> {
  const [row] = await createDb(db).select({ n: count() }).from(github_tokens);
  return row?.n ?? 0;
}

/** Records that a token was just used. */
export async function markGithubTokenUsed(db: D1Database, id: string, at: Date): Promise<void> {
  await createDb(db)
    .update(github_tokens)
    .set({ last_used_at: at })
    .where(eq(github_tokens.id, id));
}

/** Forgets every token (their secrets went with the sandbox Worker); returns how many. */
export async function forgetGithubTokens(db: D1Database): Promise<number> {
  const rows = await createDb(db).delete(github_tokens).returning({ id: github_tokens.id });
  return rows.length;
}

export interface GithubTokenDeps {
  db: D1Database;
  /** Whether the manager has its `SANDBOX` binding, and the sandbox Worker's `info()`. */
  sandbox(): Promise<{ connected: boolean; info: SandboxInfo | null }>;
  /** `PUT /workers/scripts/appflare-sandbox/secrets` with the manager's token. */
  putSandboxSecret(name: string, value: string): Promise<void>;
  /** `DELETE /workers/scripts/appflare-sandbox/secrets/<name>`; a missing secret is not an error. */
  deleteSandboxSecret(name: string): Promise<void>;
  now?: () => Date;
  newId?: () => string;
}

/** Refuses a secret change while a job runs in the sandbox Worker (a new version would stop it). */
async function refuseWhileBusy(db: D1Database): Promise<void> {
  const busy = await activeSandboxJob(createDb(db));
  if (busy !== null) {
    const message = sandboxBusyMessage(busy);
    throw new GithubTokenError(`${message[0]?.toUpperCase() ?? ""}${message.slice(1)}.`);
  }
}

/**
 * Records a new token, then stores it as a secret on the sandbox Worker.
 * Marking it for release downloads unmarks any other token.
 */
export async function addGithubTokenCore(
  deps: GithubTokenDeps,
  raw: AddGithubTokenInput,
): Promise<{ id: string }> {
  const input = addGithubTokenInput.parse(raw);
  const sandbox = await deps.sandbox();
  if (!sandbox.connected) {
    throw new GithubTokenError(
      `GitHub access tokens are kept on the sandbox Worker. Enable sandbox builds in ${ENABLE_SANDBOX_PLACE} first.`,
    );
  }
  if (sandbox.info === null) {
    throw new GithubTokenError("The sandbox Worker did not answer. Try again in a minute.");
  }
  if (!usesGithubTokens(sandbox.info)) {
    throw new GithubTokenError(
      `The sandbox Worker ${sandbox.info.sandboxVersion} cannot use GitHub access tokens yet: to update it, ${UPDATE_SANDBOX_HINT}.`,
    );
  }
  await refuseWhileBusy(deps.db);
  const id = (deps.newId ?? (() => ulid()))();
  const at = (deps.now ?? (() => new Date()))();
  const orm = createDb(deps.db);
  // The record first, the secret second: a failed write then leaves no
  // secret nothing knows about, only a record to take back.
  const previouslyForReleases = input.forReleases
    ? (
        await orm
          .select({ id: github_tokens.id })
          .from(github_tokens)
          .where(eq(github_tokens.for_releases, true))
      ).map((r) => r.id)
    : [];
  const insert = orm.insert(github_tokens).values({
    id,
    label: input.label,
    repositories: input.repositories,
    for_releases: input.forReleases,
    created_at: at,
    last_used_at: null,
  });
  if (input.forReleases) {
    await orm.batch([orm.update(github_tokens).set({ for_releases: false }), insert]);
  } else {
    await insert;
  }
  try {
    await deps.putSandboxSecret(githubTokenSecretName(id), input.token);
  } catch (error) {
    await orm.delete(github_tokens).where(eq(github_tokens.id, id));
    if (previouslyForReleases.length > 0) {
      await orm
        .update(github_tokens)
        .set({ for_releases: true })
        .where(inArray(github_tokens.id, previouslyForReleases));
    }
    throw error;
  }
  return { id };
}

/** How long after adding a token the sandbox Worker may still answer from a version without it. */
export const JUST_ADDED_MS = 5 * 60_000;

/** Whether a token was added so recently that the sandbox Worker may not hold it yet. */
export function addedJustNow(record: Pick<GithubTokenRecord, "createdAt">, now: Date): boolean {
  return now.getTime() - record.createdAt < JUST_ADDED_MS;
}

/** What to say when the sandbox Worker does not hold a token added a moment ago. */
export function justAddedMessage(label: string): string {
  return `the GitHub access token "${label}" was just added, and the sandbox Worker does not have it yet; try again in a minute`;
}

/** The record of one token, or null. */
export async function readGithubToken(
  db: D1Database,
  id: string,
): Promise<GithubTokenRecord | null> {
  return (await readGithubTokens(db)).find((t) => t.id === id) ?? null;
}

/** Deletes a token's secret from the sandbox Worker, then its record. */
export async function deleteGithubTokenCore(deps: GithubTokenDeps, id: string): Promise<void> {
  const orm = createDb(deps.db);
  const [row] = await orm
    .select({ id: github_tokens.id })
    .from(github_tokens)
    .where(eq(github_tokens.id, id))
    .limit(1);
  if (row === undefined) throw new GithubTokenError("There is no such token.");
  const sandbox = await deps.sandbox();
  if (sandbox.connected) {
    await refuseWhileBusy(deps.db);
    await deps.deleteSandboxSecret(githubTokenSecretName(id));
  }
  await orm.delete(github_tokens).where(eq(github_tokens.id, id));
}
