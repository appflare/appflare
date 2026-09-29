import { describe, expect, it } from "vitest";
import { renderPostInstall, workersDevUrl } from "./post-install";

const WORKERS_DEV = "https://cut.appflare-dev.workers.dev";

describe("renderPostInstall", () => {
  it("fills {{appUrl}} and {{workerName}}", () => {
    const url = workersDevUrl("cut", "appflare-dev");
    expect(url).toBe(WORKERS_DEV);
    expect(
      renderPostInstall("Open {{appUrl}}/admin ({{ workerName }}).", {
        workerUrl: url,
        appUrl: url,
        workerName: "cut",
      }),
    ).toBe(`Open ${WORKERS_DEV}/admin (cut).`);
  });

  it("fills the app's address with the domain that serves it, and workers.dev with workers.dev", () => {
    const values = {
      workerUrl: WORKERS_DEV,
      appUrl: "https://links.example.com",
      workerName: "cut",
    };
    expect(renderPostInstall("{{appUrl}} {{appHostname}}", values)).toBe(
      "https://links.example.com links.example.com",
    );
    expect(renderPostInstall("{{workerUrl}} {{workerHostname}}", values)).toBe(
      `${WORKERS_DEV} cut.appflare-dev.workers.dev`,
    );
  });

  it("fills the account id and the wildcard domain when known", () => {
    const values = {
      workerUrl: WORKERS_DEV,
      appUrl: WORKERS_DEV,
      workerName: "cut",
      accountId: "0123456789abcdef0123456789abcdef",
      wildcardHostname: "tunnels.example.com",
    };
    expect(renderPostInstall("{{accountId}} *.{{wildcardHostname}}", values)).toBe(
      "0123456789abcdef0123456789abcdef *.tunnels.example.com",
    );
    expect(renderPostInstall("[{{wildcardHostname}}]", { ...values, wildcardHostname: null })).toBe(
      "[]",
    );
  });

  it("fills the per-Worker forms for an app of several Workers", () => {
    const entry = {
      web: { workerName: "cut", workerUrl: WORKERS_DEV, appUrl: "https://links.example.com" },
      api: {
        workerName: "cut-api",
        workerUrl: "https://cut-api.appflare-dev.workers.dev",
        appUrl: "https://cut-api.appflare-dev.workers.dev",
      },
    };
    const values = {
      workerUrl: WORKERS_DEV,
      appUrl: "https://links.example.com",
      workerName: "cut",
    };
    expect(
      renderPostInstall(
        "{{appUrl:web}} {{appHostname:web}} {{workerUrl:web}} {{appUrl:api}} {{workerName:api}} {{workerHostname:api}}",
        values,
        entry,
      ),
    ).toBe(
      `https://links.example.com links.example.com ${WORKERS_DEV} https://cut-api.appflare-dev.workers.dev cut-api cut-api.appflare-dev.workers.dev`,
    );
    // A Worker the entry does not have stays as written.
    expect(renderPostInstall("{{appUrl:admin}}", values, entry)).toBe("{{appUrl:admin}}");
  });

  it("leaves the address placeholders when the subdomain is unknown, and others as written", () => {
    expect(
      renderPostInstall("{{appUrl}} {{workerHostname}} {{other}}", {
        workerUrl: null,
        appUrl: null,
        workerName: "x",
      }),
    ).toBe("{{appUrl}} {{workerHostname}} {{other}}");
  });
});
