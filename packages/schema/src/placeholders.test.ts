import { describe, expect, it } from "vitest";
import {
  ACCESS_PLACEHOLDERS,
  ENTRY_WORKER_PLACEHOLDER_SOURCE,
  hasEntryWorkerPlaceholder,
  hasPlaceholder,
  INSTALL_PLACEHOLDER_SOURCE,
  INSTALL_PLACEHOLDERS,
  PER_WORKER_PLACEHOLDER_NAMES,
  PLACEHOLDER_FIELDS,
  PLACEHOLDER_NAMES,
  PLACEHOLDERS,
  POST_INSTALL_PLACEHOLDERS,
  placeholderProblems,
  renderEntryWorkerPlaceholders,
  renderJsonPlaceholders,
  renderPlaceholders,
  STAGE_PLACEHOLDER,
  urlHostname,
} from "./placeholders";

const values = {
  workerUrl: "https://inbox.acme.workers.dev",
  appUrl: "https://mail.example.com",
  workerName: "inbox",
};

describe("the placeholder list", () => {
  it("names every placeholder once, with what it means", () => {
    expect(PLACEHOLDER_NAMES).toEqual([
      "appUrl",
      "appHostname",
      "workerUrl",
      "workerHostname",
      "workerName",
      "accountId",
      "wildcardHostname",
      "accessTeamDomain",
      "accessAud",
      "accessCertsUrl",
      "stage",
    ]);
    for (const p of PLACEHOLDERS) expect(p.meaning.length).toBeGreaterThan(20);
    expect(PER_WORKER_PLACEHOLDER_NAMES).toEqual([
      "appUrl",
      "appHostname",
      "workerUrl",
      "workerHostname",
      "workerName",
    ]);
  });

  it("says {{workerUrl}} is always the workers.dev address and {{appUrl}} the served one", () => {
    const meaning = (name: string) => PLACEHOLDERS.find((p) => p.name === name)?.meaning ?? "";
    expect(meaning("workerUrl")).toContain("Always the workers.dev address");
    expect(meaning("appUrl")).toContain("custom domain while workers.dev is turned off");
  });

  it("says which fields take which", () => {
    expect(PLACEHOLDER_FIELDS.postInstall).toEqual(POST_INSTALL_PLACEHOLDERS);
    expect(PLACEHOLDER_FIELDS.varDefault).toEqual(INSTALL_PLACEHOLDERS);
    // The Access values go to a var only, never to a note people read.
    for (const name of ACCESS_PLACEHOLDERS) {
      expect(PLACEHOLDER_FIELDS.varDefault).toContain(name);
      expect(PLACEHOLDER_FIELDS.postInstall).not.toContain(name);
    }
    expect(PLACEHOLDER_FIELDS.selfDeployingWorkerName).toEqual(["stage"]);
    expect(INSTALL_PLACEHOLDERS).not.toContain("stage");
    expect(STAGE_PLACEHOLDER).toBe("{{stage}}");
  });

  it("exports regular expression sources the manager's chips build on", () => {
    expect(new RegExp(INSTALL_PLACEHOLDER_SOURCE).exec("x {{ appHostname }}")?.[1]).toBe(
      "appHostname",
    );
    const entry = new RegExp(ENTRY_WORKER_PLACEHOLDER_SOURCE).exec("{{workerHostname:api}}");
    expect(entry?.slice(1)).toEqual(["workerHostname", "api"]);
    expect(new RegExp(INSTALL_PLACEHOLDER_SOURCE).test("{{stage}}")).toBe(false);
  });
});

describe("renderPlaceholders", () => {
  it("fills in the Access values of a protected install, and empty ones of an unprotected one", () => {
    const text = "{{accessTeamDomain}}|{{ accessAud }}|{{accessCertsUrl}}";
    expect(
      renderPlaceholders(text, {
        ...values,
        access: {
          teamDomain: "acme.cloudflareaccess.com",
          aud: "a1b2",
          certsUrl: "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
        },
      }),
    ).toBe("acme.cloudflareaccess.com|a1b2|https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
    expect(renderPlaceholders(text, { ...values, access: null })).toBe("||");
    // Not known (a form showing a default): kept as written.
    expect(renderPlaceholders(text, values)).toBe(text);
  });

  it("fills in the addresses, their hostnames and the Worker name", () => {
    expect(
      renderPlaceholders(
        "{{appUrl}} {{ appHostname }} {{workerUrl}}/api {{workerHostname}} {{ workerName }}",
        values,
      ),
    ).toBe(
      "https://mail.example.com mail.example.com https://inbox.acme.workers.dev/api inbox.acme.workers.dev inbox",
    );
    expect(renderPlaceholders("{{other}} stays", values)).toBe("{{other}} stays");
    expect(hasPlaceholder("x {{ appUrl }}")).toBe(true);
    expect(hasPlaceholder("{{other}}")).toBe(false);
  });

  it("keeps an address and its hostname while it is unknown", () => {
    expect(
      renderPlaceholders("{{workerUrl}} {{workerHostname}} {{appUrl}} {{appHostname}}", {
        ...values,
        workerUrl: null,
        appUrl: null,
      }),
    ).toBe("{{workerUrl}} {{workerHostname}} {{appUrl}} {{appHostname}}");
  });

  it("fills in the wildcard hostname, empty while none is assigned, kept while unknown", () => {
    expect(
      renderPlaceholders("{{wildcardHostname}}", { ...values, wildcardHostname: "t.example.com" }),
    ).toBe("t.example.com");
    expect(
      renderPlaceholders("[{{ wildcardHostname }}]", { ...values, wildcardHostname: null }),
    ).toBe("[]");
    expect(renderPlaceholders("{{wildcardHostname}}", values)).toBe("{{wildcardHostname}}");
  });

  it("fills in the account id, and keeps {{accountId}} while it is unknown", () => {
    const account = "0123456789abcdef0123456789abcdef";
    expect(
      renderPlaceholders("id={{accountId}} {{ accountId }}", { ...values, accountId: account }),
    ).toBe(`id=${account} ${account}`);
    expect(renderPlaceholders("{{accountId}}", values)).toBe("{{accountId}}");
    expect(renderPlaceholders("{{accountId}}", { ...values, accountId: null })).toBe(
      "{{accountId}}",
    );
  });

  it("leaves {{stage}} and per-Worker forms alone", () => {
    expect(renderPlaceholders("{{stage}} {{appUrl:api}}", values)).toBe("{{stage}} {{appUrl:api}}");
  });

  it("reads a hostname off a URL", () => {
    expect(urlHostname("https://a.example.com:8443/x?y#z")).toBe("a.example.com:8443");
    expect(urlHostname("https://a.example.com")).toBe("a.example.com");
  });
});

describe("renderJsonPlaceholders", () => {
  it("fills in strings inside JSON values, never keys", () => {
    expect(
      renderJsonPlaceholders(
        { "{{workerName}}": ["{{appUrl}}", 1, true, null, { u: "{{workerName}}" }] },
        values,
      ),
    ).toEqual({
      "{{workerName}}": ["https://mail.example.com", 1, true, null, { u: "inbox" }],
    });
    expect(renderJsonPlaceholders(3, values)).toBe(3);
  });

  it("keeps a __proto__ key as an own property", () => {
    const parsed = JSON.parse('{"__proto__":{"u":"{{workerName}}"},"a":1}');
    const rendered = renderJsonPlaceholders(parsed, values);
    expect(JSON.stringify(rendered)).toBe('{"__proto__":{"u":"inbox"},"a":1}');
    expect(Object.getPrototypeOf(rendered)).toBe(Object.prototype);
  });
});

describe("renderEntryWorkerPlaceholders", () => {
  const workers = {
    api: {
      workerName: "mail-api",
      workerUrl: "https://mail-api.acme.workers.dev",
      appUrl: "https://mail-api.acme.workers.dev",
    },
    web: {
      workerName: "mail",
      workerUrl: "https://mail.acme.workers.dev",
      appUrl: "https://mail.example.com",
    },
    internal: { workerName: "mail-internal", workerUrl: null, appUrl: null },
  };

  it("fills in each form for the Worker it names", () => {
    expect(
      renderEntryWorkerPlaceholders(
        "{{appUrl:web}} {{appHostname:web}} {{workerUrl:web}} {{workerHostname:api}} {{ workerName:internal }}",
        workers,
      ),
    ).toBe(
      "https://mail.example.com mail.example.com https://mail.acme.workers.dev mail-api.acme.workers.dev mail-internal",
    );
    expect(hasEntryWorkerPlaceholder("{{appUrl:web}}")).toBe(true);
    expect(hasEntryWorkerPlaceholder("{{appUrl}}")).toBe(false);
  });

  it("keeps a placeholder for an unknown Worker or an address it does not have", () => {
    expect(renderEntryWorkerPlaceholders("{{workerUrl:internal}} {{appUrl:nope}}", workers)).toBe(
      "{{workerUrl:internal}} {{appUrl:nope}}",
    );
  });
});

describe("placeholderProblems", () => {
  const entry = {
    workers: [
      { name: "web", workersDev: true },
      { name: "internal", workersDev: false },
    ],
  };

  it("finds nothing wrong with the placeholders a field takes", () => {
    expect(placeholderProblems("{{appUrl}}/x {{accountId}}", "varDefault")).toEqual([]);
    expect(placeholderProblems("app-{{stage}}", "selfDeployingWorkerName")).toEqual([]);
    expect(
      placeholderProblems("{{appUrl:web}} {{workerName:internal}}", "postInstall", entry),
    ).toEqual([]);
  });

  it("refuses a placeholder the field does not take", () => {
    expect(placeholderProblems("{{stage}}", "varDefault")[0]).toContain(
      "{{stage}} is not filled in here",
    );
    expect(placeholderProblems("{{appUrl}}", "selfDeployingWorkerName")[0]).toContain(
      "this field takes {{stage}}",
    );
  });

  it("takes the Access placeholders in a var's value only", () => {
    expect(
      placeholderProblems("{{accessTeamDomain}} {{accessAud}} {{accessCertsUrl}}", "varDefault"),
    ).toEqual([]);
    expect(placeholderProblems("{{accessAud}}", "postInstall")[0]).toContain(
      "{{accessAud}} is not filled in here",
    );
    expect(placeholderProblems("{{accessAud:web}}", "varDefault", entry)[0]).toContain(
      "has no per-Worker form",
    );
  });

  it("refuses a known name in the wrong case, which would be left as written", () => {
    expect(placeholderProblems("{{ workerURL }}", "postInstall")).toEqual([
      "{{ workerURL }} is not a placeholder; placeholder names are case-sensitive, so write {{workerUrl}}",
    ]);
    expect(placeholderProblems("{{AppUrl:web}}", "postInstall", entry)[0]).toContain(
      "write {{appUrl:web}}",
    );
  });

  it("refuses per-Worker forms that name no Worker of the entry, or one without an address", () => {
    expect(placeholderProblems("{{appUrl:web}}", "postInstall")[0]).toContain(
      "this entry installs one Worker",
    );
    expect(placeholderProblems("{{appUrl:api}}", "postInstall", entry)[0]).toContain(
      'names the Worker "api", which install.workers does not declare',
    );
    expect(placeholderProblems("{{workerUrl:internal}}", "postInstall", entry)[0]).toContain(
      "sets workersDev to false and so has no address",
    );
    expect(placeholderProblems("{{accountId:web}}", "postInstall", entry)[0]).toContain(
      "has no per-Worker form",
    );
  });

  it("leaves other double-brace text alone", () => {
    expect(placeholderProblems("{{name}} {{ user.name }} {{#each}}", "postInstall")).toEqual([]);
  });
});
