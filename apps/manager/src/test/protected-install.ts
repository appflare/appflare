import { env } from "cloudflare:workers";
import { sealServiceTokenSecret } from "../access/service-token-secret";

/**
 * Test-only: records an install as protected with Cloudflare Access, as
 * protecting it leaves it: its own service token (secret sealed with
 * `authSecret`) and its Access application. The install row must exist.
 */
export async function recordProtectedInstall(opts: {
  installId: string;
  authSecret: string;
  secret: string;
  tokenId?: string;
  clientId?: string;
  /** Null: the token exists, but the install is not protected (yet). */
  accessAppId?: string | null;
}): Promise<void> {
  const tokenId = opts.tokenId ?? `tok-${opts.installId}`;
  const sealed = await sealServiceTokenSecret(
    opts.authSecret,
    { installId: opts.installId, tokenId },
    opts.secret,
  );
  await env.DB.prepare(
    `INSERT INTO install_access (install_id, access_app_id, probes_policy_id, token_id,
       token_client_id, token_secret, token_expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 1, 1)`,
  )
    .bind(
      opts.installId,
      opts.accessAppId === undefined ? `app-${opts.installId}` : opts.accessAppId,
      opts.accessAppId === null ? null : `apol-${opts.installId}`,
      tokenId,
      opts.clientId ?? `client-${opts.installId}.access`,
      sealed,
    )
    .run();
}
