import { Buffer } from "node:buffer";
import { z } from "zod";
import { channelSettingsSchema } from "./channels";

/**
 * Channel credentials at rest, and the generic webhook's signature.
 *
 * Key custody: the AES-GCM key is derived with HKDF-SHA256 from the Worker
 * secret `BETTER_AUTH_SECRET`, under a label used for nothing else. That
 * secret is random, set when the manager is first deployed, present in every
 * version since, and never in D1, so the key lives only in the Worker's
 * secrets while the ciphertext lives in D1. A key the manager wrote to
 * itself as a new secret on first use would add a deployment to the first
 * save, a race between isolates that could each mint a key, and a window in
 * which older isolates cannot read the rows; rolling the Worker back to a
 * version from before that secret would also lose it. The label keeps the
 * derived key unrelated to anything Better Auth derives from the same secret.
 *
 * Each ciphertext is bound to its channel id (AES-GCM additional data), so
 * a row's credentials cannot be moved to another row.
 */

const FORMAT = "v1";
const HKDF_SALT = "appflare/notification-channels";
const HKDF_INFO = "channel credentials v1";

/** Credentials as stored: what the admin entered, plus a webhook's signing secret. */
export const storedConfigSchema = z.discriminatedUnion("kind", [
  channelSettingsSchema.options[0],
  channelSettingsSchema.options[1],
  channelSettingsSchema.options[2],
  channelSettingsSchema.options[3].extend({ secret: z.string().min(32) }),
]);
export type StoredConfig = z.infer<typeof storedConfigSchema>;

export class ChannelKeyError extends Error {
  override name = "ChannelKeyError";
}

const keys = new Map<string, Promise<CryptoKey>>();

/** The AES-GCM key for channel credentials, derived once per isolate. */
export function channelKey(secret: string | undefined): Promise<CryptoKey> {
  if (secret === undefined || secret.length === 0) {
    return Promise.reject(new ChannelKeyError("BETTER_AUTH_SECRET is not set on this Worker."));
  }
  let key = keys.get(secret);
  if (key === undefined) {
    key = (async () => {
      const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new TextEncoder().encode(HKDF_SALT),
          info: new TextEncoder().encode(HKDF_INFO),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keys.set(secret, key);
  }
  return key;
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const fromB64url = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = Buffer.from(text, "base64url");
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
};

export async function encryptConfig(
  key: CryptoKey,
  channelId: string,
  config: StoredConfig,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(channelId) },
    key,
    new TextEncoder().encode(JSON.stringify(config)),
  );
  return `${FORMAT}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/** The stored credentials, or null when they cannot be read with this key. */
export async function decryptConfig(
  key: CryptoKey,
  channelId: string,
  sealed: string,
): Promise<StoredConfig | null> {
  const [format, iv, data] = sealed.split(".");
  if (format !== FORMAT || iv === undefined || data === undefined) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(iv), additionalData: new TextEncoder().encode(channelId) },
      key,
      fromB64url(data),
    );
    const parsed = storedConfigSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A generic webhook's signing secret: 32 random bytes, base64url, with a recognisable prefix. */
export function newSigningSecret(): string {
  return `afwhsec_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** `sha256=<hex HMAC-SHA256 of the body>`, keyed with the secret's UTF-8 bytes. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Buffer.from(mac).toString("hex")}`;
}

/** Every credential string in a config, for scrubbing error text. */
export function secretsOf(config: StoredConfig): string[] {
  switch (config.kind) {
    case "telegram":
      return [config.botToken, config.botToken.split(":")[1] ?? ""];
    case "slack":
    case "discord":
      return [config.webhookUrl, new URL(config.webhookUrl).pathname];
    case "webhook":
      return [config.url, config.secret, new URL(config.url).pathname];
  }
}
