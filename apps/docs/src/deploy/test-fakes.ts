import { createHash, createHmac } from "node:crypto";
import type { StepAnswer } from "./installer-api.ts";

/**
 * A pretend world for the deploy page's tests, behind one `fetch`: the
 * hosted installer at `/api/install/*` on the page's origin, Cloudflare's
 * token endpoint, and new Appflare managers at their addresses. Every
 * request is recorded, so tests can check what went where.
 */

export const ORIGIN = "https://appflare.dev";
export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const OTHER_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
export const CLIENT_ID = "b99863433175d812f9595af56dd1b71d";

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeInstallation {
  id: string;
  key: string;
  accountId: string;
  workerName: string;
  hostname: string | null;
  address: string;
  handoffHash: string;
  status: string;
  /** What `/step` answers next, one per request; the last one repeats. */
  script: StepAnswer[];
  stepCalls: number;
  cleanupCalls: number;
}

export interface FakeManagerState {
  /** sha256 hex of the handoff secret it holds. */
  hash: string;
  state: "waiting" | "received" | "done";
  /** Set by a successful POST. */
  received: Record<string, unknown> | null;
  /** Answers to force: a status instead of a real answer. */
  forceStatus?: number;
  /** Answer the proof wrongly (a page that is not this installation). */
  impostor?: boolean;
  /** No answer at all (DNS, certificate). */
  unreachable?: boolean;
  /** Answers for the next POSTs, in order, before the real ones. */
  postAnswers?: Array<{ status: number; body: unknown }>;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function proofFor(hashHex: string, challenge: string): string {
  return createHmac("sha256", Buffer.from(hashHex, "hex"))
    .update(`appflare-handoff:${challenge}`)
    .digest("base64url");
}

export const DEFAULT_STEPS: StepAnswer[] = [
  { status: "running", step: { id: "database", label: "Create the database" }, done: 1, total: 4 },
  { status: "running", step: { id: "worker", label: "Upload Appflare" }, done: 2, total: 4 },
  {
    status: "deployed",
    step: { id: "proof", label: "Wait for Appflare to answer" },
    done: 4,
    total: 4,
  },
];

export class FakeWorld {
  readonly requests: Recorded[] = [];
  accounts = [
    { id: ACCOUNT_ID, name: "Main account", workersDevSubdomain: "main-sub" as string | null },
  ];
  zones: Record<string, Array<{ id: string; name: string }>> = {
    [ACCOUNT_ID]: [{ id: "z1", name: "example.com" }],
  };
  takenNames = new Set<string>();
  takenHosts = new Map<string, string>();
  release = "0.4.2";
  installations = new Map<string, FakeInstallation>();
  managers = new Map<string, FakeManagerState>();
  /** Steps a new installation will answer. */
  steps: StepAnswer[] = DEFAULT_STEPS;
  /** The access tokens Cloudflare currently accepts. */
  validAccess = new Set<string>(["access-1"]);
  /** The refresh tokens Cloudflare currently accepts; each works once. */
  validRefresh = new Set<string>(["refresh-1"]);
  refreshCount = 0;
  /** Answer every installer request with this status and error code. */
  installerDown: { status: number; code: string } | null = null;
  /** An installer that answers a new installation with this address instead of its own. */
  addressOverride: string | null = null;
  private counter = 0;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === "string" ? init.body : "";
    const method = init.method ?? "GET";
    this.requests.push({ url: input, method, headers, body });
    const url = new URL(input, ORIGIN);
    if (url.href === "https://dash.cloudflare.com/oauth2/token") return this.token(body);
    if (url.origin === ORIGIN && url.pathname.startsWith("/api/install/")) {
      return this.installer(url.pathname.slice("/api/install/".length), headers, body);
    }
    const manager = this.managers.get(url.origin);
    if (manager !== undefined && url.pathname === "/api/handoff") {
      return this.manager(url, method, body, manager);
    }
    throw new TypeError("fetch failed");
  };

  private token(body: string): Response {
    const form = new URLSearchParams(body);
    const refresh = form.get("refresh_token") ?? "";
    if (form.get("grant_type") !== "refresh_token" || !this.validRefresh.has(refresh)) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    this.refreshCount++;
    this.validRefresh.delete(refresh);
    const access = `access-${this.refreshCount + 1}`;
    const next = `refresh-${this.refreshCount + 1}`;
    this.validAccess.add(access);
    this.validRefresh.add(next);
    return Response.json({ access_token: access, expires_in: 3600, refresh_token: next });
  }

  private error(status: number, code: string, message = `Refused: ${code}`): Response {
    return Response.json({ error: { code, message } }, { status });
  }

  private installer(path: string, headers: Record<string, string>, raw: string): Response {
    if (this.installerDown !== null) {
      return this.error(this.installerDown.status, this.installerDown.code);
    }
    const token = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    if (token === undefined || !this.validAccess.has(token)) {
      return this.error(401, "cloudflare_auth", "Connect your Cloudflare account again.");
    }
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    const parts = path.split("/");
    if (path === "accounts") return Response.json({ accounts: this.accounts });
    if (path === "zones") {
      return Response.json({ zones: this.zones[String(body.accountId)] ?? [] });
    }
    if (path === "release") return Response.json({ release: { version: this.release } });
    if (path === "check") {
      const hostname = body.hostname as string | null;
      const conflict = hostname === null ? undefined : this.takenHosts.get(hostname);
      return Response.json({
        workerName: this.takenNames.has(String(body.workerName)) ? "taken" : "free",
        hostname:
          hostname === null
            ? null
            : conflict === undefined
              ? "free"
              : { conflict: "dns", detail: conflict },
      });
    }
    if (path === "installations") {
      this.counter++;
      const id = `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
      const key = `k${String(this.counter).padStart(42, "x")}`;
      const account = this.accounts.find((a) => a.id === body.accountId);
      const workerName = String(body.workerName);
      const hostname = (body.hostname as string | null) ?? null;
      const address =
        this.addressOverride ??
        (hostname !== null
          ? `https://${hostname}`
          : `https://${workerName}.${account?.workersDevSubdomain}.workers.dev`);
      this.installations.set(id, {
        id,
        key,
        accountId: String(body.accountId),
        workerName,
        hostname,
        address,
        handoffHash: String(body.handoffHash),
        status: "running",
        script: [...this.steps],
        stepCalls: 0,
        cleanupCalls: 0,
      });
      this.addManager(address, String(body.handoffHash));
      if (hostname !== null && account?.workersDevSubdomain) {
        this.addManager(
          `https://${workerName}.${account.workersDevSubdomain}.workers.dev`,
          String(body.handoffHash),
        );
      }
      return Response.json({
        installationId: id,
        key,
        release: { version: this.release },
        address,
      });
    }
    if (path === "installations/find") {
      const list = [...this.installations.values()]
        .filter((i) => i.accountId === body.accountId)
        .map((i) => ({
          id: i.id,
          workerName: i.workerName,
          hostname: i.hostname,
          address: i.address,
          status: i.status,
          step: { id: "worker", label: "Upload Appflare" },
          done: 2,
          total: 4,
          release: { version: this.release },
          createdAt: "2026-10-06T10:00:00.000Z",
          updatedAt: "2026-10-06T10:05:00.000Z",
        }));
      return Response.json({ installations: list });
    }
    const [, id, action] = parts;
    const record = id === undefined ? undefined : this.installations.get(id);
    if (record === undefined) return this.error(404, "not_found", "There is nothing here.");
    if (action === "step") {
      if (body.key !== record.key) return this.error(403, "wrong_key");
      const answer = record.script[Math.min(record.stepCalls, record.script.length - 1)];
      record.stepCalls++;
      if (answer === undefined) return this.error(500, "internal");
      record.status = answer.status;
      return Response.json(answer);
    }
    if (action === "cleanup") {
      if (body.key !== undefined && body.key !== record.key) return this.error(403, "wrong_key");
      record.cleanupCalls++;
      if (record.cleanupCalls === 1) {
        return Response.json({
          status: "running",
          step: { id: "worker", label: "Remove the Appflare Worker" },
          done: 2,
          total: 6,
        });
      }
      this.installations.delete(record.id);
      return Response.json({
        status: "removed",
        step: { id: "record", label: "Forget the installation" },
        done: 6,
        total: 6,
      });
    }
    return this.error(404, "not_found");
  }

  addManager(address: string, hash: string): FakeManagerState {
    const state: FakeManagerState = { hash, state: "waiting", received: null };
    this.managers.set(new URL(address).origin, state);
    return state;
  }

  private manager(url: URL, method: string, raw: string, m: FakeManagerState): Response {
    if (m.unreachable) throw new TypeError("fetch failed");
    if (m.forceStatus !== undefined) return new Response("{}", { status: m.forceStatus });
    if (method === "GET") {
      const challenge = url.searchParams.get("challenge") ?? "";
      const proof = m.impostor
        ? proofFor(sha256Hex("someone else"), challenge)
        : proofFor(m.hash, challenge);
      return Response.json({ app: "appflare", version: "0.4.2", state: m.state, proof });
    }
    const forced = m.postAnswers?.shift();
    if (forced !== undefined) return Response.json(forced.body, { status: forced.status });
    const body = JSON.parse(raw) as { secret?: string };
    if (m.state === "done") return Response.json({ error: "done" }, { status: 409 });
    if (typeof body.secret !== "string" || sha256Hex(body.secret) !== m.hash) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (m.state === "waiting") m.received = body as Record<string, unknown>;
    m.state = "received";
    return Response.json({
      ok: true,
      ownerSetupUrl: `${url.origin}/setup#claim=claim0123456789abcdef`,
    });
  }
}
