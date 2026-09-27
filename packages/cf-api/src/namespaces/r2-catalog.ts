import type { HttpApi } from "../http";

const enc = encodeURIComponent;

/**
 * R2 Data Catalog: the Apache Iceberg catalog of one R2 bucket
 * (`/accounts/{id}/r2-catalog/{bucket}`). Shapes are the `r2-data-catalog_*`
 * schemas of Cloudflare's API schema; wrangler 4.136.2 makes the same calls
 * (`src/r2/helpers/catalog.ts`). Every write needs a token with Workers R2
 * Data Catalog Write.
 */

/** Cloudflare's error code for a bucket without a catalog (`GET` answers 404). */
export const R2_CATALOG_NOT_FOUND_CODE = 40401;

/** A bucket's catalog as `GET /r2-catalog/{bucket}` returns it (fields Appflare reads). */
export interface R2Catalog {
  id: string;
  bucket: string;
  name?: string;
  /** `active` once enabled. */
  status?: string;
  /** Whether a maintenance credential is stored: `present` or `absent`. */
  credential_status?: string | null;
}

/**
 * `POST /r2-catalog/{bucket}/maintenance-configs`. Every field is optional;
 * only what is sent changes. Compaction is sent without `target_size_mb`
 * (Cloudflare's default is 128 MB): the API schema gives it as a string and
 * wrangler 4.136.2 sends `targetSizeMb` as a number, so neither form is sure
 * to be read.
 */
export interface CatalogMaintenanceUpdate {
  compaction?: { state: "enabled" | "disabled" };
  snapshot_expiration?: {
    state: "enabled" | "disabled";
    /** `<number><d|h|m|s>`, for example `30d`. */
    max_snapshot_age?: string;
    min_snapshots_to_keep?: number;
  };
}

export function createR2Catalog(http: HttpApi) {
  return {
    /** `GET /r2-catalog/{bucket}`; a bucket without a catalog answers 404 with code 40401. */
    get(bucket: string): Promise<R2Catalog> {
      return http.result("GET", http.acct(`/r2-catalog/${enc(bucket)}`));
    },

    /**
     * `POST /r2-catalog/{bucket}/enable`: makes the bucket an Iceberg
     * warehouse. Answers `{ id, name }` (`r2-data-catalog_catalog-activation-response`),
     * `name` being the warehouse, `<account id>_<bucket>`.
     */
    enable(bucket: string): Promise<{ id: string; name: string } | null> {
      return http.result("POST", http.acct(`/r2-catalog/${enc(bucket)}/enable`));
    },

    /**
     * `POST /r2-catalog/{bucket}/delete[?force=true]`: removes the catalog
     * from the control plane, leaving the bucket's objects. With `force` it
     * also removes its namespaces, tables and maintenance settings, which
     * otherwise outlive a deleted bucket and stop a sink from creating a
     * table of the same name in a new bucket of the same name.
     */
    remove(bucket: string, opts: { force?: boolean } = {}): Promise<unknown> {
      return http.result("POST", http.acct(`/r2-catalog/${enc(bucket)}/delete`), {
        query: { force: opts.force === true ? "true" : undefined },
      });
    },

    /**
     * `POST /r2-catalog/{bucket}/credential` with `{ token }`: the API token
     * table maintenance runs with. The body carries the token.
     */
    storeCredential(bucket: string, token: string): Promise<unknown> {
      return http.result("POST", http.acct(`/r2-catalog/${enc(bucket)}/credential`), {
        json: { token },
      });
    },

    /** `POST /r2-catalog/{bucket}/maintenance-configs`. */
    updateMaintenance(bucket: string, update: CatalogMaintenanceUpdate): Promise<unknown> {
      return http.result("POST", http.acct(`/r2-catalog/${enc(bucket)}/maintenance-configs`), {
        json: update,
      });
    },
  };
}
