import type { HttpApi } from "../http";

const enc = encodeURIComponent;

/**
 * The origin of a Hyperdrive configuration for a database reachable on the
 * public internet: the "Public Database" variant of
 * `hyperdrive_hyperdrive-origin-full` in Cloudflare's API schema, whose
 * fields are all required. `password` is write-only: the API never returns it.
 */
export interface HyperdriveOriginInput {
  scheme: "postgres" | "postgresql" | "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * The body of `POST /accounts/{id}/hyperdrive/configs` for caller-supplied
 * origin credentials (`hyperdrive_hyperdrive-config-create-with-origin`):
 * `name` and `origin` are required; `caching` is optional and, when sent,
 * either `{ disabled: true }` or `{ disabled: false, max_age?,
 * stale_while_revalidate? }` (`max_age` 1 to 3600 seconds, default 60;
 * `stale_while_revalidate` default 15).
 */
export interface CreateHyperdriveConfigArgs {
  name: string;
  origin: HyperdriveOriginInput;
  caching?:
    | { disabled: true }
    | { disabled?: false; max_age?: number; stale_while_revalidate?: number };
}

/**
 * The body of `PATCH /accounts/{id}/hyperdrive/configs/{id}` Appflare
 * sends: only `caching`, every field of the patch being optional, so the
 * origin (and its password, which Appflare does not keep) is left as it is.
 */
export interface PatchHyperdriveConfigArgs {
  caching: { disabled: boolean };
}

/** A Hyperdrive configuration as the API returns it (fields Appflare reads; never a password). */
export interface HyperdriveConfig {
  id: string;
  name: string;
  origin?: { scheme?: string; host?: string; port?: number; database?: string; user?: string };
  caching?: { disabled?: boolean; max_age?: number; stale_while_revalidate?: number };
  created_on?: string;
  modified_on?: string;
}

/** Page size of the configuration list (the API's maximum). */
const LIST_PAGE_SIZE = 100;

/**
 * Hyperdrive configurations. Request bodies carry the database password, and
 * the client never puts a request body in an error message or a log line.
 */
export function createHyperdrive(http: HttpApi) {
  return {
    /** `POST /hyperdrive/configs`. Cloudflare connects to the origin before it answers. */
    createConfig(args: CreateHyperdriveConfigArgs): Promise<HyperdriveConfig> {
      const body: Record<string, unknown> = { name: args.name, origin: { ...args.origin } };
      if (args.caching !== undefined) body.caching = args.caching;
      return http.result("POST", http.acct("/hyperdrive/configs"), { json: body });
    },

    /**
     * `GET /hyperdrive/configs?page=&per_page=`: every configuration in the
     * account. The list reports `total_count` rather than `total_pages`, so
     * it is read page by page until a short page or the total is reached.
     */
    async listConfigs(): Promise<HyperdriveConfig[]> {
      const all: HyperdriveConfig[] = [];
      for (let page = 1; page <= 1000; page++) {
        const envelope = await http.send("GET", http.acct("/hyperdrive/configs"), {
          query: { page, per_page: LIST_PAGE_SIZE },
        });
        const rows = Array.isArray(envelope.result) ? (envelope.result as HyperdriveConfig[]) : [];
        all.push(...rows);
        const total = envelope.result_info?.total_count;
        if (rows.length < LIST_PAGE_SIZE || (total !== undefined && all.length >= total)) break;
      }
      return all;
    },

    /** `GET /hyperdrive/configs/{id}`. */
    getConfig(id: string): Promise<HyperdriveConfig> {
      return http.result("GET", http.acct(`/hyperdrive/configs/${enc(id)}`));
    },

    /**
     * `PATCH /hyperdrive/configs/{id}`: changes only what `args` names (query
     * caching), keeping the origin and its credentials.
     */
    patchConfig(id: string, args: PatchHyperdriveConfigArgs): Promise<HyperdriveConfig> {
      return http.result("PATCH", http.acct(`/hyperdrive/configs/${enc(id)}`), {
        json: { caching: { disabled: args.caching.disabled } },
      });
    },

    /** `DELETE /hyperdrive/configs/{id}`. */
    deleteConfig(id: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/hyperdrive/configs/${enc(id)}`));
    },
  };
}
