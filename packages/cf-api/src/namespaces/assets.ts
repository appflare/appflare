import type { AssetUploadManifest } from "../asset-hash";
import type { HttpApi } from "../http";
import type { AssetUploadSession } from "../types";

const enc = encodeURIComponent;

/** One file in a bucket upload: its hash and its already-base64-encoded body. */
export interface AssetBucketFile {
  /** The 32-hex asset hash; used as both the form-field name and the filename. */
  hash: string;
  /** Base64 of the file's raw bytes (the manager base64s with `Buffer`). */
  base64: string;
  /** Served content type; `application/null` means "send no Content-Type". */
  contentType?: string;
}

/** Result of a bucket upload; `jwt` is the completion token on the final bucket. */
export interface AssetBucketResult {
  jwt: string | null;
}

/** Static-assets upload. */
export function createAssets(http: HttpApi) {
  return {
    /**
     * `POST /workers/scripts/{name}/assets-upload-session` with `{ manifest }`.
     * Returns the session `jwt` and the `buckets` of hashes Cloudflare still needs.
     */
    createUploadSession(name: string, manifest: AssetUploadManifest): Promise<AssetUploadSession> {
      return http.result("POST", http.acct(`/workers/scripts/${enc(name)}/assets-upload-session`), {
        json: { manifest },
      });
    },

    /**
     * `POST /workers/assets/upload?base64=true` — one multipart part per file, the
     * part name and filename both the file hash and the body the base64 string.
     * Authorized with the session `jwt`, NOT the account token. Returns the
     * completion `jwt` once the last bucket is uploaded.
     */
    uploadBucket(sessionJwt: string, files: AssetBucketFile[]): Promise<AssetBucketResult> {
      const form = new FormData();
      for (const file of files) {
        const blob = new Blob([file.base64], { type: file.contentType ?? "application/null" });
        form.append(file.hash, blob, file.hash);
      }
      return http.result("POST", http.acct("/workers/assets/upload"), {
        query: { base64: true },
        form,
        token: sessionJwt,
      });
    },

    /**
     * `POST /workers/assets/upload/{hash}` with the raw file bytes: the upload
     * path wrangler 4.136.2 takes when the session JWT carries
     * `wrangler_single_asset_uploads: true`. Authorized with the session `jwt`.
     */
    uploadFile(
      sessionJwt: string,
      file: { hash: string; body: string | Uint8Array; contentType?: string },
    ): Promise<AssetBucketResult> {
      return http.result("POST", http.acct(`/workers/assets/upload/${enc(file.hash)}`), {
        raw: { body: file.body, contentType: file.contentType ?? "application/null" },
        token: sessionJwt,
      });
    },
  };
}
