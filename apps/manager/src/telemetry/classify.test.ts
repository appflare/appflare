import { describe, expect, it } from "vitest";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "../access/messages";
import { PROTECT_MESSAGES } from "../access/protect.server";
import { CF_MESSAGE_MAX, classifyJobError, failedPhase, splitJobError } from "./classify";

/** Error texts as the jobs write them (`<step>: <message>`). */
describe("classifyJobError", () => {
  it("reads a Cloudflare API failure's status, code and Cloudflare's own message, never the request", () => {
    expect(
      classifyJobError(
        "create kv SESSIONS: Cloudflare API request failed: POST /accounts/abc/storage/kv/namespaces -> 403: [10000] Authentication error",
      ),
    ).toEqual({
      errorCategory: "cloudflare_permission",
      failedPhase: "resources",
      cfStatus: 403,
      cfCode: 10000,
      cfMessage: "Authentication error",
    });
    expect(
      classifyJobError(
        "upload Worker version: Cloudflare API request failed: PUT /accounts/abc/workers/scripts/cut -> 400: [10021] Uncaught Error",
      ),
    ).toMatchObject({ errorCategory: "cloudflare_rejected", failedPhase: "upload", cfCode: 10021 });
    expect(
      classifyJobError("promote version: Cloudflare API request failed: POST /x -> 503"),
    ).toEqual({
      errorCategory: "cloudflare_unavailable",
      failedPhase: "promote",
      cfStatus: 503,
      cfCode: null,
      cfMessage: null,
    });
    expect(
      classifyJobError("set cron triggers: Cloudflare API request failed: PUT /x -> 429"),
    ).toMatchObject({ errorCategory: "cloudflare_rate_limited", failedPhase: "crons" });
  });

  it("recognises plan limits, the subrequest limit and name conflicts", () => {
    expect(
      classifyJobError(
        "set cron triggers: Cloudflare refused 1 cron trigger: this account has reached the Workers Free limit of 5 cron triggers per account.",
      ),
    ).toMatchObject({ errorCategory: "plan_limit", failedPhase: "crons" });
    expect(
      classifyJobError(
        "upload Worker version: Cloudflare API request failed: PUT /x -> 400: [10027] Your Worker exceeded the size limit",
      ),
    ).toMatchObject({ errorCategory: "plan_limit", cfCode: 10027 });
    expect(
      classifyJobError(
        "upload assets: Too many subrequests by single Worker invocation. Cloudflare allows 50 subrequests per Worker invocation on the free plan",
      ),
    ).toMatchObject({ errorCategory: "subrequest_limit", failedPhase: "assets" });
    expect(
      classifyJobError(
        "check Worker name: a Worker named cut already exists in this account; Appflare does not adopt existing Workers",
      ),
    ).toMatchObject({ errorCategory: "name_conflict", failedPhase: "preflight" });
  });

  it("recognises artifact integrity and fetch failures", () => {
    expect(
      classifyJobError(
        "verify artifact manifest: manifest.json digest abc123 does not match the catalog index (def456)",
      ),
    ).toMatchObject({ errorCategory: "artifact_integrity", failedPhase: "preflight" });
    expect(
      classifyJobError(
        "upload Worker version: worker/index.js: sha256 0a1b does not match the manifest",
      ),
    ).toMatchObject({ errorCategory: "artifact_integrity" });
    expect(
      classifyJobError("load artifact manifest: GET github.com/appflare/catalog/x.json -> 404"),
    ).toMatchObject({ errorCategory: "artifact_fetch", failedPhase: "preflight" });
  });

  it("falls back to the phase for job-specific failures", () => {
    for (const step of [
      "D1 DB: apply migrations",
      "D1 DB: apply schema",
      "D1 DB: apply schema from src/db/indexes.sql",
      "D1 DB: apply post-deploy migrations",
    ]) {
      expect(classifyJobError(`${step}: near "FROM": syntax error`)).toMatchObject({
        errorCategory: "d1_migration",
        failedPhase: "d1_migrations",
      });
    }
    expect(classifyJobError("canary check 5: the preview never served")).toMatchObject({
      errorCategory: "canary",
      failedPhase: "canary",
    });
    expect(
      classifyJobError("build in sandbox: the build failed in its install step (exit code 1): x"),
    ).toMatchObject({ errorCategory: "sandbox_build", failedPhase: "sandbox" });
    expect(classifyJobError("deploy in sandbox: alchemy exited with 1")).toMatchObject({
      errorCategory: "installer",
      failedPhase: "installer",
    });
    expect(classifyJobError("preflight checks: the app needs a zone")).toMatchObject({
      errorCategory: "preflight",
      failedPhase: "preflight",
    });
  });

  it("recognises cancellations and timeouts, and knows when it does not know", () => {
    expect(classifyJobError("the job's Workflow instance was terminated")).toMatchObject({
      errorCategory: "cancelled",
      failedPhase: "other",
    });
    expect(classifyJobError("health check 3: timed out")).toMatchObject({
      errorCategory: "timeout",
      failedPhase: "health",
    });
    expect(classifyJobError("the job's Workflow instance no longer exists")).toEqual({
      errorCategory: "unknown",
      failedPhase: "other",
      cfStatus: null,
      cfCode: null,
      cfMessage: null,
    });
    expect(classifyJobError(null).errorCategory).toBe("unknown");
  });
});

describe("Cloudflare's message", () => {
  it("is the text after the code, from the step's message on", () => {
    expect(
      classifyJobError(
        "D1 DB: apply schema: worker/schema.sql: Cloudflare API request failed: POST /accounts/0123456789abcdef0123456789abcdef/d1/database/4a5b6c7d-0000-4000-8000-123456789abc/query -> 400: [7500] incomplete input: SQLITE_ERROR",
      ),
    ).toEqual({
      errorCategory: "cloudflare_rejected",
      failedPhase: "d1_migrations",
      cfStatus: 400,
      cfCode: 7500,
      cfMessage: "incomplete input: SQLITE_ERROR",
    });
  });

  it("is cleaned of the account's names and anything private-looking, and cut short", () => {
    const names = { subdomain: "ada", hostnames: ["links.example.com"], workers: ["my-links"] };
    const { cfMessage } = classifyJobError(
      "upload Worker version: Cloudflare API request failed: PUT /accounts/x/workers/scripts/my-links -> 400: [10021] Uncaught Error: my-links cannot reach links.example.com or my-links.ada.workers.dev for owner@example.com with token=s3cr3tvalue",
      names,
    );
    expect(cfMessage).toBe(
      "Uncaught Error: [worker] cannot reach [domain] or [domain] for [email] with token=[redacted]",
    );
    const long = classifyJobError(
      `set secret A: Cloudflare API request failed: PUT /x -> 400: [10000] ${"word ".repeat(80)}`,
    ).cfMessage;
    expect(long?.length).toBe(CF_MESSAGE_MAX);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("masks hostnames and quoted text it does not know, and every name Appflare recorded", () => {
    const names = {
      subdomain: "ada",
      hostnames: [],
      workers: ["cut"],
      names: ["acme-backups-2026", "Appflare: Cut (cut)"],
    };
    const cases: Array<[string, string]> = [
      // A custom domain whose creation failed, so Appflare never recorded it.
      [
        "attach custom domain: Cloudflare API request failed: PUT /accounts/x/workers/domains -> 409: [100117] Hostname 'shop.private-corp.com' already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option 'override_existing_dns_record' to override.",
        "Hostname '[redacted]' already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option '[redacted]' to override.",
      ],
      [
        "add external domain: Cloudflare API request failed: POST /zones/z/custom_hostnames -> 409: [1406] Duplicate custom hostname found for go.customer.net.",
        "Duplicate custom hostname found for [domain].",
      ],
      [
        "create wildcard route: Cloudflare API request failed: POST /zones/z/workers/routes -> 409: [10020] A route with the same pattern *.tunnels.private-corp.com/* already exists",
        "A route with the same pattern [domain]/* already exists",
      ],
      // A bucket named in Cloudflare's words.
      [
        "create R2 bucket acme-backups-2026: Cloudflare API request failed: PUT /accounts/x/r2/buckets/acme-backups-2026 -> 409: [10004] Bucket acme-backups-2026 already exists, and you own it.",
        "Bucket [name] already exists, and you own it.",
      ],
      [
        'protect with Cloudflare Access: Cloudflare API request failed: PUT /accounts/x/access/apps/a -> 404: [12130] access.api.error.not_found: application "Intranet (corp)" or Appflare: Cut (cut) not found',
        'access.api.error.not_found: application "[redacted]" or [name] not found',
      ],
      [
        "protect with Cloudflare Access: Cloudflare API request failed: POST /accounts/x/access/apps -> 409: [11010] access.api.error.conflict: domain already in use",
        "access.api.error.conflict: domain already in use",
      ],
      [
        "D1 DB: apply migrations: 0001_init.sql: Cloudflare API request failed: POST /accounts/x/d1/database/d/query -> 400: [7500] near `users`: syntax error: SQLITE_ERROR",
        "near `[redacted]`: syntax error: SQLITE_ERROR",
      ],
      // Cloudflare's own hostnames say where to look.
      [
        "upload Worker version: Cloudflare API request failed: PUT /x -> 400: [10021] see dash.cloudflare.com and cut-x.ada.workers.dev, it's 'cut'",
        "see dash.cloudflare.com and [domain], it's '[redacted]'",
      ],
    ];
    for (const [error, expected] of cases) {
      expect(classifyJobError(error, names).cfMessage, error).toBe(expected);
    }
    // Without the account's names, nothing of the message.
    expect(classifyJobError(cases[0]?.[0] ?? "", null)).toMatchObject({
      errorCategory: "cloudflare_rejected",
      cfCode: 100117,
      cfMessage: null,
    });
  });

  it("masks IP addresses and words shaped like names, keeping error constants, keys and codes", () => {
    const cf = (message: string) =>
      classifyJobError(
        `upload Worker version: Cloudflare API request failed: PUT /x -> 400: [10021] ${message}`,
      ).cfMessage;
    for (const [message, expected] of [
      // IP literals, a port after one kept.
      ["connect to 10.20.30.40:5432 refused", "connect to [ip]:5432 refused"],
      ["origin 2001:db8:85a3::8a2e:370:7334 unreachable", "origin [ip] unreachable"],
      [
        "origin 2001:0db8:85a3:0000:0000:8a2e:0370:7334 or fe80::1%eth0 or ::1",
        "origin [ip] or [ip] or [ip]",
      ],
      // Names nobody recorded, without a dot.
      [
        "binding acme-payroll-api refers to acme_corp_prod and backups2026",
        "binding [name] refers to [name] and [name]",
      ],
      // Error constants, Cloudflare's keys, codes in brackets, statuses and limits.
      ["incomplete input: SQLITE_ERROR", "incomplete input: SQLITE_ERROR"],
      [
        "D1_ERROR: [7500] near acme_db_2 (SQLITE_ERROR)",
        "D1_ERROR: [7500] near [name] (SQLITE_ERROR)",
      ],
      [
        "access.api.error.not_found: upstream returned 502 after 30000 ms; [10021] limit 1MB",
        "access.api.error.not_found: upstream returned 502 after 30000 ms; [10021] limit 1MB",
      ],
      [
        "compatibility date 2026-10-01 needs version 4.12.0",
        "compatibility date 2026-10-01 needs version 4.12.0",
      ],
      // A name in plain words cannot be told from Cloudflare's own and stays.
      ["application Intranet Portal not found", "application Intranet Portal not found"],
    ] as const) {
      expect(cf(message), message).toBe(expected);
    }
  });

  it("ends where Cloudflare's text ends, before what Appflare wrote around it", () => {
    for (const [error, expected] of [
      // In brackets, as an uninstall words a bucket it could not delete.
      [
        "delete R2 bucket acme-data: Cloudflare refused to delete the bucket (Cloudflare API request failed: DELETE /accounts/x/r2/buckets/acme-data -> 409: [10008] The bucket you tried to delete (or part of it) is not empty). A bucket with incomplete multipart uploads cannot be deleted; abort them with the S3 API",
        "The bucket you tried to delete (or part of it) is not empty",
      ],
      [
        "record version: Could not read which version serves now (Cloudflare API request failed: GET /x -> 500: [10013] An unknown error occurred); Appflare records the uploaded version 0a1b.",
        "An unknown error occurred",
      ],
      // After a semicolon or on a line of its own; Cloudflare's own errors stay together.
      [
        "set secrets: Cloudflare API request failed: PUT /x -> 400: [10021] Script not valid; Appflare kept the version that serves",
        "Script not valid",
      ],
      [
        "set secrets: Cloudflare API request failed: PUT /x -> 400: [10021] Script not valid; [10022] Missing binding\nAppflare kept the version that serves",
        "Script not valid; [10022] Missing binding",
      ],
    ] as const) {
      expect(classifyJobError(error).cfMessage, error).toBe(expected);
    }
  });

  it("is only carried by a Cloudflare category", () => {
    expect(
      classifyJobError(
        "set cron triggers: Cloudflare API request failed: PUT /x -> 400: [10072] Your account has reached the limit",
      ),
    ).toMatchObject({ errorCategory: "plan_limit", cfCode: 10072, cfMessage: null });
    expect(
      classifyJobError(
        "upload Worker version: Cloudflare API request failed: PUT /x -> 400: [10021] the upload timed out",
      ),
    ).toMatchObject({ errorCategory: "timeout", cfMessage: null });
  });
});

describe("Cloudflare Access failures", () => {
  const steps = [
    "protect with Cloudflare Access",
    "cover the app's Workers with Cloudflare Access",
    "update Cloudflare Access destinations",
    "remove Cloudflare Access protection",
    "take dropped public paths off Cloudflare Access",
    "keep Worker my-assets-installer unreachable",
  ];

  it("fail in the access phase", () => {
    for (const step of steps) expect(failedPhase(step)).toBe("access");
    expect(failedPhase("check access to the Cloudflare account")).not.toBe("access");
  });

  it("tell another application on the app's address from a refused permission and a missing organization", () => {
    const conflict = PROTECT_MESSAGES.conflict("Workers", [
      "appflare-agentic-inbox.ada.workers.dev",
      "*-appflare-agentic-inbox.ada.workers.dev",
    ]);
    expect(classifyJobError(`protect with Cloudflare Access: ${conflict}`)).toEqual({
      errorCategory: "access_conflict",
      failedPhase: "access",
      cfStatus: null,
      cfCode: null,
      cfMessage: null,
    });
    for (const message of [
      INSTALL_ACCESS_MESSAGES.policiesPermission,
      INSTALL_ACCESS_MESSAGES.tokensPermission,
      ACCESS_MESSAGES.organizationPermission,
    ]) {
      expect(
        classifyJobError(`cover the app's Workers with Cloudflare Access: ${message}`),
      ).toMatchObject({ errorCategory: "cloudflare_permission", failedPhase: "access" });
    }
    for (const message of [ACCESS_MESSAGES.noOrganization, PROTECT_MESSAGES.noSubdomain]) {
      expect(classifyJobError(`protect with Cloudflare Access: ${message}`)).toMatchObject({
        errorCategory: "preflight",
        failedPhase: "access",
      });
    }
    expect(
      classifyJobError(
        "update Cloudflare Access destinations: Cloudflare API request failed: PUT /accounts/x/access/apps/y -> 409: [12132] access.api.error.conflict: destination belongs to another application",
      ),
    ).toMatchObject({
      errorCategory: "cloudflare_rejected",
      failedPhase: "access",
      cfMessage: "access.api.error.conflict: destination belongs to another application",
    });
  });

  it("never take a hostname in the message for the step", () => {
    // A later ": " in the message, after a hostname a phase is known by.
    const text =
      'protect with Cloudflare Access: The Cloudflare Access application "Workers" already covers cut.ada.workers.dev: an address of this app';
    expect(splitJobError(text).step).toBe("protect with Cloudflare Access");
    expect(splitJobError("start: the app needs: a zone").step).toBe("start");
    expect(splitJobError("D1 DB: apply migrations: near: x")).toEqual({
      step: "D1 DB: apply migrations",
      message: "near: x",
    });
    expect(splitJobError("no step here")).toEqual({ step: "", message: "no step here" });
  });
});

describe("a catalog that is gone", () => {
  it("fails the preflight", () => {
    expect(
      classifyJobError(
        'catalog keys: the catalog "community" this app comes from was removed from Appflare; add it again to install or update its apps',
      ),
    ).toMatchObject({ errorCategory: "preflight", failedPhase: "preflight" });
  });
});

describe("failedPhase", () => {
  it("maps step names (which carry resource names) to a fixed set of phases", () => {
    expect(failedPhase("create r2 my-private-bucket")).toBe("resources");
    expect(failedPhase("set secret STRIPE_KEY")).toBe("secrets");
    expect(failedPhase("remove custom domain app.example.com")).toBe("domains");
    expect(failedPhase("route hello@example.com to the Worker")).toBe("email_routing");
    expect(failedPhase("bookmark D1 notes")).toBe("snapshot");
    expect(failedPhase("empty r2 media page 2")).toBe("delete");
    expect(failedPhase("delete kv cache")).toBe("delete");
    expect(failedPhase("record Worker name")).toBe("record");
    expect(failedPhase("finish")).toBe("record");
    expect(failedPhase("something new")).toBe("other");
  });
});
