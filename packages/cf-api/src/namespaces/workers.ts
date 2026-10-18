import type { HttpApi } from "../http";
import { buildUploadFormData, type WorkerModule } from "../modules";
import type {
  AccountSubdomain,
  DurableObjectNamespace,
  ScriptMetadata,
  ScriptSettings,
  ScriptUploadResult,
  SubdomainResult,
  WorkerObservability,
  WorkerSchedule,
  WorkerScript,
  WorkerSecret,
} from "../types";

const enc = encodeURIComponent;

/** Durable Object namespaces read per page. */
const NAMESPACE_PAGE_SIZE = 1000;

export interface UploadScriptArgs {
  metadata: ScriptMetadata;
  modules: WorkerModule[];
  /**
   * `?excludeScript=true`: leave the uploaded modules out of the response, as
   * wrangler 4.136.2 does on `wrangler deploy`. The result still carries
   * `deployment_id` (the new version id, possibly without hyphens).
   */
  excludeScript?: boolean;
}

export interface EnableSubdomainArgs {
  enabled: boolean;
  previews_enabled?: boolean;
}

export interface PutSecretArgs {
  name: string;
  text: string;
  /** Defaults to `secret_text`. */
  type?: string;
}

/** Worker script lifecycle. */
export function createWorkers(http: HttpApi) {
  return {
    /** `GET /workers/scripts` (paginated). */
    listScripts(): Promise<WorkerScript[]> {
      return http.list("GET", http.acct("/workers/scripts"));
    },

    /** `PUT /workers/scripts/{name}` — multipart metadata + module parts. */
    uploadScript(name: string, args: UploadScriptArgs): Promise<ScriptUploadResult> {
      const form = buildUploadFormData(args.metadata, args.modules);
      return http.result("PUT", http.acct(`/workers/scripts/${enc(name)}`), {
        form,
        query: args.excludeScript ? { excludeScript: true } : undefined,
      });
    },

    /** `DELETE /workers/scripts/{name}` (`?force=true` also removes referenced resources). */
    deleteScript(name: string, opts: { force?: boolean } = {}): Promise<unknown> {
      return http.result("DELETE", http.acct(`/workers/scripts/${enc(name)}`), {
        query: opts.force ? { force: true } : undefined,
      });
    },

    /** `GET /workers/scripts/{name}/settings`. */
    getSettings(name: string): Promise<Record<string, unknown>> {
      return http.result("GET", http.acct(`/workers/scripts/${enc(name)}/settings`));
    },

    /** `PATCH /workers/scripts/{name}/settings` — multipart with a `settings` JSON part. */
    patchSettings(
      name: string,
      settings: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const form = new FormData();
      form.set("settings", JSON.stringify(settings));
      return http.result("PATCH", http.acct(`/workers/scripts/${enc(name)}/settings`), { form });
    },

    /**
     * `GET /workers/scripts/{name}/script-settings`: the settings that are
     * not part of a version, Workers Observability among them
     * (`observability` is `null` on a script that never had it set).
     */
    getScriptSettings(name: string): Promise<ScriptSettings> {
      return http.result("GET", http.acct(`/workers/scripts/${enc(name)}/script-settings`));
    },

    /**
     * Turns a Worker's Workers Observability (Workers Logs) on or off:
     * `PATCH /workers/scripts/{name}/script-settings` with
     * `{ observability: { enabled } }` alone, as JSON (as wrangler sends
     * it), so no other setting can change. It creates no new version and
     * needs only the Workers Scripts permission.
     */
    setObservability(name: string, enabled: boolean): Promise<ScriptSettings> {
      return http.result("PATCH", http.acct(`/workers/scripts/${enc(name)}/script-settings`), {
        json: { observability: { enabled } },
      });
    },

    /**
     * Puts back a Worker's whole Workers Observability block, as
     * `getScriptSettings` read it (sampling rates, logs and traces
     * included): `PATCH /workers/scripts/{name}/script-settings` with
     * `{ observability: block }` alone, as JSON, so no other setting can
     * change. Like {@link setObservability}, it creates no new version.
     */
    setObservabilitySettings(name: string, block: WorkerObservability): Promise<ScriptSettings> {
      return http.result("PATCH", http.acct(`/workers/scripts/${enc(name)}/script-settings`), {
        json: { observability: block },
      });
    },

    /** `GET /workers/scripts/{name}/bindings`. */
    getBindings(name: string): Promise<unknown[]> {
      return http.result("GET", http.acct(`/workers/scripts/${enc(name)}/bindings`));
    },

    /** `POST /workers/scripts/{name}/subdomain` — enable/disable workers.dev. */
    enableSubdomain(name: string, args: EnableSubdomainArgs): Promise<SubdomainResult> {
      return http.result("POST", http.acct(`/workers/scripts/${enc(name)}/subdomain`), {
        json: args,
      });
    },

    /** `GET /workers/scripts/{name}/subdomain` — whether its workers.dev route (and previews) are on. */
    getSubdomain(name: string): Promise<SubdomainResult> {
      return http.result("GET", http.acct(`/workers/scripts/${enc(name)}/subdomain`));
    },

    /** `GET /workers/scripts/{name}/schedules` (cron triggers). */
    getSchedules(name: string): Promise<{ schedules: WorkerSchedule[] }> {
      return http.result("GET", http.acct(`/workers/scripts/${enc(name)}/schedules`));
    },

    /** `PUT /workers/scripts/{name}/schedules` — body is an array of `{ cron }`. */
    putSchedules(
      name: string,
      schedules: Array<{ cron: string }>,
    ): Promise<{ schedules: WorkerSchedule[] }> {
      return http.result("PUT", http.acct(`/workers/scripts/${enc(name)}/schedules`), {
        json: schedules,
      });
    },

    /** `GET /workers/scripts/{name}/secrets`. */
    listSecrets(name: string): Promise<WorkerSecret[]> {
      return http.result("GET", http.acct(`/workers/scripts/${enc(name)}/secrets`));
    },

    /** `PUT /workers/scripts/{name}/secrets` — `{ name, text, type: "secret_text" }`. */
    putSecret(name: string, secret: PutSecretArgs): Promise<WorkerSecret> {
      return http.result("PUT", http.acct(`/workers/scripts/${enc(name)}/secrets`), {
        json: { name: secret.name, text: secret.text, type: secret.type ?? "secret_text" },
      });
    },

    /** `DELETE /workers/scripts/{name}/secrets/{secretName}`. */
    deleteSecret(name: string, secretName: string): Promise<unknown> {
      return http.result(
        "DELETE",
        http.acct(`/workers/scripts/${enc(name)}/secrets/${enc(secretName)}`),
      );
    },

    /**
     * `GET /workers/durable_objects/namespaces` (paginated): every Durable
     * Object namespace of the account, with the Worker (`script`) and `class`
     * that implement it. Wrangler 4.136.2 reads it for the namespace of a
     * container class the Worker does not bind. The list reports
     * `total_count` rather than `total_pages`, so it is read page by page
     * while the total says more, or (without a total) until a page shorter
     * than its `per_page` (Cloudflare caps it at 1,000). An answer without
     * the list throws rather than read as "no namespaces": callers decide
     * what is left behind from it.
     */
    async listDurableObjectNamespaces(): Promise<DurableObjectNamespace[]> {
      const all: DurableObjectNamespace[] = [];
      for (let page = 1; page <= 1000; page++) {
        const envelope = await http.send("GET", http.acct("/workers/durable_objects/namespaces"), {
          query: { page, per_page: NAMESPACE_PAGE_SIZE },
        });
        if (!Array.isArray(envelope.result)) {
          throw Object.assign(new Error("the Durable Object namespaces answer holds no list"), {
            name: "UnreadableDurableObjectNamespaces",
          });
        }
        const rows = envelope.result as DurableObjectNamespace[];
        all.push(...rows);
        if (rows.length === 0) break;
        const info = envelope.result_info;
        const more =
          info?.total_count !== undefined
            ? all.length < info.total_count
            : rows.length >= (info?.per_page ?? NAMESPACE_PAGE_SIZE);
        if (!more) break;
      }
      return all;
    },

    /**
     * `GET /workers/durable_objects/namespaces/{id}`: one namespace. One that
     * does not exist (its Worker or class was deleted) answers 404, code 10066.
     */
    getDurableObjectNamespace(id: string): Promise<DurableObjectNamespace> {
      return http.result("GET", http.acct(`/workers/durable_objects/namespaces/${enc(id)}`));
    },

    /** `GET /workers/subdomain` — the account's workers.dev subdomain. */
    getAccountSubdomain(): Promise<AccountSubdomain> {
      return http.result("GET", http.acct("/workers/subdomain"));
    },
  };
}
