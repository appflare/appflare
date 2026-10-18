import { describe, expect, it } from "vitest";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "../access/messages";
import { PROTECT_MESSAGES } from "../access/protect.server";
import { CONNECTION_MESSAGES } from "../cloudflare/connection-errors";
import { SIGN_IN_WORDS } from "../cloudflare/sign-in-words";
import { ADDRESS_ANSWERS, addressAnswerOf } from "../domains/address-answer";
import { ADDRESS_MESSAGES } from "../domains/manager-address.server";
import { MOVE_FAILURES, MOVE_STEPS } from "../domains/move-address-lines";
import { accountWorkersProblem, entryBudgetProblem } from "../jobs/entry-budget";
import { r2NotEnabledMessage } from "../jobs/install/r2-enablement";
import { INSTANCE_NEVER_STARTED } from "../jobs/reconcile.server";
import {
  CF_MESSAGE_MAX,
  classifyJobError,
  ERROR_CATEGORIES,
  FAILURE_REASONS,
  failedPhase,
  PREFLIGHT_REASONS,
  splitJobError,
} from "./classify";

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
      failureReason: null,
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
      failureReason: null,
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
    expect(
      classifyJobError(
        "check D1 database limit: this app needs a new D1 database and the account already has 10; Workers Free allows 10 per account, so this would make 11.",
      ),
    ).toMatchObject({ errorCategory: "plan_limit", failedPhase: "preflight" });
    expect(
      classifyJobError(
        "create D1 database cut-db: Cloudflare API request failed: POST /x -> 403: [7406] System limit reached: databases per account (10)",
      ),
    ).toMatchObject({ errorCategory: "plan_limit", failedPhase: "resources", cfCode: 7406 });
    // The job's error when Cloudflare refuses a D1 database at the limit.
    expect(
      classifyJobError(
        "create D1 database cut-db: Cloudflare refused another D1 database: this account has reached its limit of 10 D1 databases per account (Cloudflare API request failed: POST /accounts/acc0000000000000000000000000000a/d1/database -> 403: [7406] System limit reached: databases per account (10)). Delete D1 databases the account no longer uses (for example by uninstalling an app that has one without keeping its data), or upgrade the account to Workers Paid (50,000 per account), then try again.",
      ),
    ).toMatchObject({
      errorCategory: "plan_limit",
      failedPhase: "resources",
      cfStatus: 403,
      cfCode: 7406,
    });
    // Cloudflare's refusal at the limit alone: no reason, as the job failed after the preflight.
    expect(
      classifyJobError(
        "create D1 database cut-db: Cloudflare API request failed: POST /accounts/abc/d1/database -> 403: [7406] System limit reached: databases per account (10)",
      ),
    ).toMatchObject({
      errorCategory: "plan_limit",
      failedPhase: "resources",
      failureReason: null,
      cfStatus: 403,
      cfCode: 7406,
    });
    // Without Cloudflare's answer, the sentence alone names the limit.
    expect(
      classifyJobError(
        "create D1 database cut-db: Cloudflare refused another D1 database: this account has reached its limit of 10 D1 databases per account. Delete D1 databases the account no longer uses, then try again.",
      ).errorCategory,
    ).toBe("plan_limit");
  });

  it("knows a pause's and a resume's reads of the app's Workers", () => {
    expect(failedPhase("check the app's Workers")).toBe("preflight");
    expect(failedPhase("read Worker my-assets-snapshot")).toBe("preflight");
    expect(
      classifyJobError(
        "check the app's Workers: the app's Worker \"cut\" is gone from the account (it was deleted outside Appflare), so the app cannot run again. Uninstall the app to remove what is left of it",
      ),
    ).toMatchObject({
      errorCategory: "preflight",
      failedPhase: "preflight",
      failureReason: "deleted_outside",
    });
    expect(
      classifyJobError(
        'read Worker cut: every Worker of the app ("cut", "cut-api") is gone from the account (they were deleted outside Appflare), so there is nothing of it to pause. Uninstall the app to remove what is left of it',
      ),
    ).toMatchObject({
      errorCategory: "preflight",
      failedPhase: "preflight",
      failureReason: "deleted_outside",
    });
    expect(
      classifyJobError(
        "read Pipelines streams: The Pipelines stream of EVENTS (id streams-1), which an earlier update made, is gone from the account; uninstall the app and install this version instead",
      ),
    ).toMatchObject({ errorCategory: "preflight", failureReason: "deleted_outside" });
  });

  it("knows the uninstall's steps for Email Routing and domains", () => {
    expect(failedPhase("restore catch-all *@example.com")).toBe("email_routing");
    expect(failedPhase("remove email route inbox@example.com")).toBe("email_routing");
    expect(failedPhase("remove external domain shop.example.net")).toBe("domains");
    expect(failedPhase("remove wildcard domain example.com")).toBe("domains");
    expect(failedPhase("remove gateway binding APP_CUT")).toBe("domains");
    expect(failedPhase("skip Worker cut")).toBe("delete");
  });

  it("keeps a name in an uninstall step from matching another phase", () => {
    expect(failedPhase("remove external domain installer.example.net")).toBe("domains");
    expect(failedPhase("remove gateway binding SNAPSHOT_ASSETS")).toBe("domains");
    expect(failedPhase("restore catch-all *@snapshot.example.com")).toBe("email_routing");
    expect(failedPhase("forget email route bookmark@example.com")).toBe("email_routing");
    expect(failedPhase("skip Worker shop-installer")).toBe("delete");
    expect(failedPhase("skip Worker snapshot-assets")).toBe("delete");
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
    // A job whose Workflow instance ended without recording its end.
    expect(classifyJobError("the job's Workflow instance no longer exists")).toEqual({
      errorCategory: "job_stopped",
      failedPhase: "other",
      failureReason: null,
      cfStatus: null,
      cfCode: null,
      cfMessage: null,
    });
    // A job whose Workflow instance Cloudflare never started.
    expect(classifyJobError(INSTANCE_NEVER_STARTED)).toMatchObject({
      errorCategory: "job_stopped",
      failedPhase: "other",
      failureReason: null,
    });
    expect(classifyJobError("finish: something nobody wrote down")).toMatchObject({
      errorCategory: "unknown",
      failedPhase: "record",
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
      failureReason: null,
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
      failureReason: null,
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

describe("a move of Appflare's address that never answered", () => {
  const HOST = "appflare.example.com";
  const failure = (last: string, stillComing = false) =>
    MOVE_FAILURES.neverAnswered(HOST, last, false, { minutes: 15, stillComing });

  it("fails in the address phase and says what answered instead, as a fixed word", () => {
    expect(classifyJobError(failure("HTTP 404, error code 1042", true))).toEqual({
      errorCategory: "address_not_serving",
      failedPhase: "address",
      failureReason: "address_not_attached",
      cfStatus: null,
      cfCode: null,
      cfMessage: null,
    });
    for (const [last, reason] of [
      ["no connection (connection refused)", "address_no_connection"],
      ["HTTP 526, error code 526", "address_certificate"],
      ["HTTP 530", "address_not_attached"],
      ["Cloudflare Access asked for a sign-in", "address_access_sign_in"],
      ["HTTP 301", "address_redirect"],
      ["HTTP 403", "address_http_error"],
      ["HTTP 200 from something that is not Appflare", "address_not_appflare"],
      ["another Appflare, not this one (its handoff proof differs)", "address_other_appflare"],
      ["Appflare 0.4.3, not 0.5.0", "address_other_version"],
    ] as const) {
      expect(classifyJobError(failure(last)).failureReason).toBe(reason);
      expect(addressAnswerOf(last)).toBe(reason);
    }
  });

  it("never reads a hostname as the step", () => {
    const text = MOVE_FAILURES.neverAnswered("assets.example.com", "HTTP 526", true, {
      minutes: 60,
      stillComing: true,
    });
    expect(classifyJobError(text)).toMatchObject({
      errorCategory: "address_not_serving",
      failedPhase: "address",
      failureReason: "address_certificate",
    });
  });

  it("knows the move's steps, with or without a count after them", () => {
    for (const step of [
      MOVE_STEPS.wait,
      `${MOVE_STEPS.wait} (check 3)`,
      `${MOVE_STEPS.wait} (wait 12)`,
      MOVE_STEPS.switch,
      `${MOVE_STEPS.switch} (again)`,
      MOVE_STEPS.detach,
    ]) {
      expect(failedPhase(step), step).toBe("address");
    }
    expect(failedPhase(MOVE_STEPS.access)).toBe("access");
    // Only the move's own words: another job's step that starts alike is not the move's.
    expect(failedPhase(`${MOVE_STEPS.switch} snapshot`)).not.toBe("address");
  });

  it("tells the move's other failures apart", () => {
    expect(
      classifyJobError(
        MOVE_FAILURES.stopped("Switching the address", ADDRESS_MESSAGES.busy, HOST, false),
      ),
    ).toMatchObject({ errorCategory: "busy", failedPhase: "address", failureReason: null });
    expect(
      classifyJobError(
        MOVE_FAILURES.stopped("Switching the address", "D1_ERROR: database is locked", HOST, false),
      ),
    ).toMatchObject({ errorCategory: "manager_database", failedPhase: "address" });
    expect(
      classifyJobError(
        `${MOVE_FAILURES.stopped("Waiting for the certificate and the new address (check 3)", "D1_ERROR: x", HOST, false)}`,
      ),
    ).toMatchObject({ failedPhase: "address" });
  });
});

describe("pausing and resuming an app", () => {
  it("fails in the pause phase, whatever its Workers are called", () => {
    for (const step of [
      "undo: read what Worker my-assets serves",
      "undo: read what Worker cut-installer serves",
      "undo: read what Worker access-snapshot serves",
      "upload the stand-in of Worker cut",
      "upload the stand-ins of Workers cut, cut-api",
      "pause delivery of queue cut-events",
      "list running instances of Workflow cut-jobs",
      "pause instances of Workflow cut-jobs (1-6 of 40)",
      "serve the stand-in of Worker set-secret-assets",
      "stop container instances of sandbox",
      "undo: serve the app's version of Worker cut",
      "allow container instances of sandbox",
      "resume delivery of queue cut-events",
      "resume instances of Workflow cut-jobs",
      "wait for a fresh invocation before serve the stand-in of Worker cut",
      "serve the stand-in of Worker cut (again)",
    ]) {
      expect(failedPhase(step), step).toBe("pause");
    }
  });

  it("counts the reads before anything changes as the preflight, whatever the Workers are called", () => {
    for (const step of [
      "read the app's Durable Objects",
      "read Worker my-assets",
      "read Worker cut-installer",
      "read Worker snapshot-email-routing",
      "check the app's Workers",
      "read Worker cut (again)",
      "read what Worker my-assets serves",
      "read what Worker access-snapshot serves",
      "wait for a fresh invocation before read what Worker cut serves",
    ]) {
      expect(failedPhase(step), step).toBe("preflight");
    }
  });

  it("names the Workflows engine's refusal of a long step name", () => {
    const step = `upload the stand-ins of Workers ${Array(10).fill("cloudflare-os-homeassistant").join(", ")}`;
    expect(
      classifyJobError(
        `${step}: Step name "${step}" exceeds max length (256 chars) or invalid characters found`,
      ),
    ).toMatchObject({ errorCategory: "workflow_limit", failedPhase: "pause" });
    expect(
      classifyJobError(
        "the job's Workflow instance failed: The limit of 1024 steps has been reached. This limit can be changed in your worker configuration.",
      ),
    ).toMatchObject({ errorCategory: "workflow_limit" });
  });

  it("knows a stand-in nobody recorded and a pause that is not for now", () => {
    expect(
      classifyJobError(
        'read Worker cut: Worker "cut" serves a stand-in of an earlier pause that Appflare has no record of; deploy the app\'s own version from the Cloudflare dashboard',
      ),
    ).toMatchObject({
      errorCategory: "external_change",
      failedPhase: "preflight",
      failureReason: "changed_outside",
    });
    expect(classifyJobError("start: the app is already paused")).toMatchObject({
      errorCategory: "install_state",
      failedPhase: "preflight",
      failureReason: "install_state",
    });
  });
});

describe("failures that no category named before", () => {
  it("each have one", () => {
    const cases: Array<[string, string]> = [
      [`check account: ${SIGN_IN_WORDS.values().next().value}`, "cloudflare_permission"],
      [`create r2 media: ${CONNECTION_MESSAGES.needsReconnect}`, "connection"],
      [`create r2 media: ${r2NotEnabledMessage("media")}`, "account_setup"],
      [
        "snapshot: a gradual deployment is in progress on cut; finish or roll it back first",
        "external_change",
      ],
      [
        "wait for the sandbox Worker to settle: Appflare is not connected to a sandbox Worker",
        "sandbox_unavailable",
      ],
      ["upload assets: Cloudflare did not return an upload token", "cloudflare_unexpected"],
      [
        "create hyperdrive DB: Cloudflare could not set up Hyperdrive for DB: bad host",
        "database_connection",
      ],
      ["empty r2 media page 1: one run deletes at most 1000 objects", "delete_incomplete"],
      ["set secret API_KEY: No value was provided for API_KEY", "input_missing"],
      ["upload Worker version: an upload without modules", "internal"],
      [
        "add custom domain app.example.com: app.example.com already serves another Worker",
        "name_conflict",
      ],
      [
        'create Workflow cut-jobs: the Workflow "cut-jobs" runs on a schedule, which needs the Workers Paid plan',
        "plan_limit",
      ],
    ];
    for (const [text, category] of cases) {
      expect(classifyJobError(text).errorCategory, text).toBe(category);
    }
  });
});

describe("a failed preflight", () => {
  it("names the check that refused, from a fixed list", () => {
    const cases: Array<[string, string]> = [
      [
        "preflight checks: this app needs Workers Paid; confirm the account is on Workers Paid to install it",
        "plan_paid_required",
      ],
      [
        "preflight checks: this app needs Email Routing; confirm the account meets these requirements to install it",
        "requirements_unconfirmed",
      ],
      ["preflight checks: the Cloudflare account is not known yet", "account_unknown"],
      [`preflight checks: ${CONNECTION_MESSAGES.notConfigured}`, "connection_needed"],
      [`preflight checks: ${accountWorkersProblem(100, 1, "free")}`, "account_limit"],
      [
        `preflight checks: ${entryBudgetProblem({ steps: 2000, subrequests: 0, unitCalls: 0, waits: 0 }, false, 30)}`,
        "job_too_big",
      ],
      ['preflight checks: another install already uses the Worker name "cut"', "name_taken"],
      [
        "check Worker name: a Worker named cut already exists in this account; Appflare does not adopt existing Workers",
        "name_taken",
      ],
      [`check R2 is enabled: ${r2NotEnabledMessage("media")}`, "r2_not_enabled"],
      [
        "check cron trigger limit: The app needs 2 cron triggers and the account's other Workers already use 4; Workers Free allows 5 per account",
        "cron_limit",
      ],
      [
        "verify artifact manifest: manifest.json digest abc123 does not match the catalog index (def456)",
        "manifest_invalid",
      ],
      [
        "load artifact manifest: GET github.com/appflare/catalog/x.json -> 404",
        "artifact_unavailable",
      ],
      [
        'catalog keys: the catalog "community" this app comes from was removed from Appflare; add it again to install or update its apps',
        "catalog_removed",
      ],
      [
        "check Worker names: Cloudflare API request failed: GET /accounts/abc/workers/scripts -> 403: [10000] Authentication error",
        "token_permission_missing",
      ],
      [
        "check Worker names: Cloudflare API request failed: GET /accounts/abc/workers/scripts -> 503",
        "cloudflare_unavailable",
      ],
      ["preflight checks: the app needs a zone", "preflight_other"],
    ];
    for (const [text, reason] of cases) {
      expect(classifyJobError(text).failureReason, text).toBe(reason);
      expect(classifyJobError(text).failedPhase, text).toBe("preflight");
    }
  });

  it("names the account's limits by the step that counts them", () => {
    const paidCopy =
      "If it is already on Workers Paid, choose that plan under [Workers plan in Your account](/settings/account#capability-workers-plan). Then try again.";
    const cases: Array<[string, string]> = [
      // The jobs' own errors (jobs/install.test.ts, jobs/update.test.ts).
      [
        `check D1 database limit: this app needs a new D1 database and the account already has 10; Workers Free allows 10 per account, so this would make 11. Delete D1 databases the account no longer uses (for example by uninstalling an app that has one without keeping its data), or upgrade the account to Workers Paid (50,000 per account). ${paidCopy}`,
        "account_limit",
      ],
      [
        "check Hyperdrive configuration limit: this app needs a new Hyperdrive configuration and the account already has 25; Workers Paid allows 25 per account, so this would make 26. Delete Hyperdrive configurations the account no longer uses (for example by uninstalling an app that connects to a database). Then try again.",
        "account_limit",
      ],
      [
        "check Vectorize index limit: this app needs 2 new Vectorize indexes and the account already has 99; Workers Free allows 100 per account, so this would make 101. Delete Vectorize indexes the account no longer uses, or upgrade the account to Workers Paid (50,000 per account). Then try again.",
        "account_limit",
      ],
      [
        `check cron trigger limit: this app needs 2 cron triggers and the account's other Workers already use 4 (second-brain: 2, appflare: 1, flaremo: 1); Workers Free allows 5 per account, so this would make 6. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account). ${paidCopy}`,
        "cron_limit",
      ],
      [
        `check cron trigger limit: this version needs 3 cron triggers and the account's other Workers already use 3 (second-brain: 2, appflare: 1); Workers Free allows 5 per account, so this would make 6. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account). ${paidCopy}`,
        "cron_limit",
      ],
      // A count that ran out of its invocation's requests and ran again.
      [
        "check D1 database limit (again): Cloudflare API request failed: GET /accounts/abc/d1/database -> 403: [7406] System limit reached: databases per account (10)",
        "account_limit",
      ],
      // Without the step, the message alone.
      [
        "preflight checks: this app needs a new D1 database and the account already has 10; Workers Free allows 10 per account, so this would make 11.",
        "account_limit",
      ],
      [
        "preflight checks: this app needs 2 cron triggers and the account's other Workers already use 4; Workers Free allows 5 per account, so this would make 6.",
        "cron_limit",
      ],
    ];
    for (const [text, reason] of cases) {
      expect(classifyJobError(text).failureReason, text).toBe(reason);
      expect(classifyJobError(text).failedPhase, text).toBe("preflight");
      expect(classifyJobError(text).errorCategory, text).toBe("plan_limit");
    }
  });

  it("does not name a limit when the count's own read failed", () => {
    expect(
      classifyJobError(
        "check D1 database limit: Cloudflare API request failed: GET /x -> 503: [10013] unavailable",
      ),
    ).toMatchObject({
      errorCategory: "cloudflare_unavailable",
      failedPhase: "preflight",
      failureReason: "cloudflare_unavailable",
    });
    expect(
      classifyJobError(
        "check cron trigger limit: Cloudflare API request failed: GET /x -> 403: [10000] Authentication error",
      ),
    ).toMatchObject({
      errorCategory: "cloudflare_permission",
      failedPhase: "preflight",
      failureReason: "token_permission_missing",
    });
  });

  it("carries no reason when the job failed later", () => {
    expect(
      classifyJobError(
        "set secret API_KEY: Cloudflare API request failed: PUT /x -> 403: [10000] no",
      ),
    ).toMatchObject({ failedPhase: "secrets", failureReason: null });
  });
});

describe("the fixed lists", () => {
  it("never repeat a value", () => {
    for (const list of [ERROR_CATEGORIES, FAILURE_REASONS, PREFLIGHT_REASONS, ADDRESS_ANSWERS]) {
      expect(new Set<string>(list).size).toBe(list.length);
    }
  });
});
