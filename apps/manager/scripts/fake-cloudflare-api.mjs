// A small, stateful, in-memory fake of the Cloudflare REST API endpoints the
// manager uses, for exercising the setup token step and the install
// Workflow in local dev without any Cloudflare account. It never forwards
// anything to Cloudflare. Local dev only.
//
//   node scripts/fake-cloudflare-api.mjs [--port 8789] [--subdomain appflare-local]
//
// Point a local manager at it with the Worker vars
//   CF_API_BASE_URL=http://127.0.0.1:8789/client/v4
//   CF_API_TOKEN=<any non-empty placeholder, never a real token>
// The account holds one Worker, `appflare`, so the /setup token step can find the
// manager. Every request is printed as `METHOD path -> status` (never headers or
// bodies).
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8789" },
    subdomain: { type: "string", default: "appflare-local" },
  },
});

const ACCOUNT = "00000000000000000000000000000001";
const state = {
  scripts: new Map([["appflare", { secrets: new Set(["SETUP_TOKEN"]), schedules: [] }]]),
  kv: [],
  d1: [],
  d1Rows: new Map(),
  r2: [],
  queues: [],
  vectorize: [],
  sessions: new Map(),
  counter: 0,
};
const id = () => (++state.counter).toString(16).padStart(32, "0");

const ok = (result, extra = {}) => [
  200,
  { success: true, errors: [], messages: [], result, ...extra },
];
const fail = (status, code, message) => [
  status,
  { success: false, errors: [{ code, message }], messages: [], result: null },
];
const page = (rows) => ok(rows, { result_info: { page: 1, per_page: 100, total_pages: 1 } });

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** The field names of a multipart body (Request parses it for us). */
async function formFields(req, body) {
  const request = new Request("http://local/", {
    method: "POST",
    headers: { "content-type": req.headers["content-type"] ?? "" },
    body,
  });
  const form = await request.formData();
  return form;
}

async function handle(req, url, body) {
  const path = url.pathname.replace(/^\/client\/v4/, "");
  const json = () => JSON.parse(body.toString("utf8") || "null");
  if (!(req.headers.authorization ?? "").startsWith("Bearer ")) {
    return fail(401, 10000, "Authentication error");
  }
  if (req.method === "GET" && path === "/user/tokens/verify") {
    return fail(401, 1000, "Invalid API Token");
  }
  if (req.method === "GET" && path === "/accounts") {
    return page([{ id: ACCOUNT, name: "Appflare Local (fake)" }]);
  }
  const acct = `/accounts/${ACCOUNT}`;
  if (!path.startsWith(acct)) return fail(404, 7003, "No route for that URI");
  const p = path.slice(acct.length);
  const key = `${req.method} ${p}`;

  if (key === "GET /tokens/verify") return ok({ id: "fake", status: "active" });
  if (key === "GET /workers/subdomain") return ok({ subdomain: values.subdomain });
  if (key === "GET /workers/scripts") {
    return ok([...state.scripts.keys()].map((name) => ({ id: name })));
  }
  if (key === "GET /storage/kv/namespaces") return page(state.kv);
  if (key === "POST /storage/kv/namespaces") {
    const { title } = json();
    if (state.kv.some((n) => n.title === title)) return fail(400, 10014, "namespace exists");
    const ns = { id: id(), title };
    state.kv.push(ns);
    return ok(ns);
  }
  if (key === "GET /d1/database") return page(state.d1);
  if (key === "POST /d1/database") {
    const { name } = json();
    const db = { uuid: crypto.randomUUID(), name };
    state.d1.push(db);
    state.d1Rows.set(db.uuid, []);
    return ok(db);
  }
  const query = /^POST \/d1\/database\/([^/]+)\/query$/.exec(key);
  if (query) {
    const applied = state.d1Rows.get(query[1]);
    if (!applied) return fail(404, 7404, "database not found");
    const { sql } = json();
    if (/^SELECT/i.test(sql)) {
      return ok([
        { results: applied.map((name, i) => ({ id: i + 1, name })), success: true, meta: {} },
      ]);
    }
    const m = /values \('([^']+)'\);$/.exec(sql);
    if (m) applied.push(m[1]);
    return ok([{ results: [], success: true, meta: {} }]);
  }
  if (key === "GET /r2/buckets") return ok({ buckets: state.r2 });
  if (key === "POST /r2/buckets") {
    const bucket = { name: json().name, creation_date: new Date().toISOString() };
    state.r2.push(bucket);
    return ok(bucket);
  }
  if (key === "GET /queues") return ok(state.queues);
  if (key === "POST /queues") {
    const queue = { queue_id: id(), queue_name: json().queue_name };
    state.queues.push(queue);
    return ok(queue);
  }
  if (key === "GET /vectorize/v2/indexes") return ok(state.vectorize);
  if (key === "POST /vectorize/v2/indexes") {
    const index = { name: json().name };
    state.vectorize.push(index);
    return ok(index);
  }

  const session = /^POST \/workers\/scripts\/([^/]+)\/assets-upload-session$/.exec(key);
  if (session) {
    const manifest = json().manifest ?? {};
    const hashes = [...new Set(Object.values(manifest).map((e) => e.hash))];
    const jwt = `fake-session-${id()}`;
    state.sessions.set(jwt, new Set(hashes));
    return ok({ jwt, buckets: hashes.length === 0 ? [] : [hashes] });
  }
  if (key === "POST /workers/assets/upload") {
    const jwt = (req.headers.authorization ?? "").slice("Bearer ".length);
    const pending = state.sessions.get(jwt);
    if (!pending) return fail(401, 10000, "bad upload session");
    const form = await formFields(req, body);
    for (const hash of form.keys()) pending.delete(hash);
    return ok({ jwt: pending.size === 0 ? `fake-completion-${id()}` : null });
  }

  const script = /^(PUT|DELETE) \/workers\/scripts\/([^/]+)$/.exec(key);
  if (script?.[1] === "PUT") {
    const form = await formFields(req, body);
    const metadata = JSON.parse(String(form.get("metadata")));
    const modules = [...form.keys()].filter((k) => k !== "metadata");
    console.log(
      `  upload ${script[2]}: main ${metadata.main_module}, modules ${modules.join(", ")}, bindings ${(
        metadata.bindings ?? []
      )
        .map((b) => `${b.type}:${b.name}`)
        .join(", ")}${metadata.assets ? ", assets" : ""}`,
    );
    state.scripts.set(script[2], { secrets: new Set(), schedules: [] });
    return ok({ id: script[2], deployment_id: id() });
  }
  const scriptOf = (name) => state.scripts.get(name);
  const secrets = /^(PUT|GET) \/workers\/scripts\/([^/]+)\/secrets$/.exec(key);
  if (secrets) {
    const s = scriptOf(secrets[2]);
    if (!s) return fail(404, 10007, "script not found");
    if (secrets[1] === "GET")
      return ok([...s.secrets].map((name) => ({ name, type: "secret_text" })));
    const { name } = json();
    s.secrets.add(name);
    return ok({ name, type: "secret_text" });
  }
  const delSecret = /^DELETE \/workers\/scripts\/([^/]+)\/secrets\/([^/]+)$/.exec(key);
  if (delSecret) {
    scriptOf(delSecret[1])?.secrets.delete(delSecret[2]);
    return ok(null);
  }
  const schedules = /^PUT \/workers\/scripts\/([^/]+)\/schedules$/.exec(key);
  if (schedules) return ok({ schedules: json() });
  const subdomain = /^POST \/workers\/scripts\/([^/]+)\/subdomain$/.exec(key);
  if (subdomain) return ok({ enabled: true, previews_enabled: true });
  return fail(404, 7003, "No route for that URI");
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let status = 500;
  let payload = { success: false, errors: [{ code: 0, message: "fake API error" }] };
  try {
    [status, payload] = await handle(req, url, await readBody(req));
  } catch (error) {
    console.error(error);
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  console.log(`${req.method} ${url.pathname} -> ${status}`);
}).listen(Number(values.port), "127.0.0.1", () => {
  console.log(`Fake Cloudflare API on http://127.0.0.1:${values.port}/client/v4`);
  console.log(`account ${ACCOUNT}, workers.dev subdomain "${values.subdomain}"`);
});
