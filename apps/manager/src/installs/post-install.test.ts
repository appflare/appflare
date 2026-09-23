import { describe, expect, it } from "vitest";
import { renderPostInstall, workersDevUrl } from "./post-install";

describe("renderPostInstall", () => {
  it("fills {{workerUrl}} and {{workerName}}", () => {
    const url = workersDevUrl("cut", "appflare-dev");
    expect(url).toBe("https://cut.appflare-dev.workers.dev");
    expect(
      renderPostInstall("Open {{workerUrl}}/admin ({{ workerName }}).", {
        workerUrl: url,
        workerName: "cut",
      }),
    ).toBe("Open https://cut.appflare-dev.workers.dev/admin (cut).");
  });

  it("leaves the URL placeholder when the subdomain is unknown, and others as written", () => {
    expect(renderPostInstall("{{workerUrl}} {{other}}", { workerUrl: null, workerName: "x" })).toBe(
      "{{workerUrl}} {{other}}",
    );
  });
});
