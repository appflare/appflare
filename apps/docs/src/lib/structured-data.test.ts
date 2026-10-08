import { describe, expect, it } from "vitest";
import { appFaq } from "../catalog/app-guide.ts";
import { siteCatalog } from "../catalog/data.ts";
import { testApp } from "../catalog/test-app.ts";
import { pageHead } from "./meta.ts";
import { SITE_URL } from "./shared.ts";
import { appStructuredData, siteStructuredData } from "./structured-data.ts";

const app = siteCatalog.apps[0];
if (!app) throw new Error("the catalog fixture has no apps");

describe("structured data", () => {
  it("describes an app's page as the app and its breadcrumb", () => {
    const data = appStructuredData(app);
    const [software, breadcrumb] = data["@graph"] as Array<Record<string, unknown>>;
    expect(software).toMatchObject({
      "@type": "WebApplication",
      name: app.name,
      url: `${SITE_URL}/apps/${app.slug}/`,
      softwareVersion: app.version,
      offers: { "@type": "Offer", price: "0" },
    });
    expect(breadcrumb).toMatchObject({ "@type": "BreadcrumbList" });
  });

  it("states exactly the questions the page answers, as an FAQPage", () => {
    const cut = testApp({ plan: "paid", services: ["kv"] });
    const nodes = appStructuredData(cut)["@graph"] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node["@type"])).toEqual([
      "WebApplication",
      "BreadcrumbList",
      "FAQPage",
    ]);
    const faq = nodes[2];
    expect(faq?.["@id"]).toBe(`${SITE_URL}/apps/cut/#faq`);
    expect(faq?.mainEntity).toEqual(
      appFaq(cut).map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer },
      })),
    );
  });

  it("describes the front page as the site, its publisher and Appflare", () => {
    const types = (siteStructuredData()["@graph"] as Array<Record<string, unknown>>).map(
      (node) => node["@type"],
    );
    expect(types).toEqual(["Organization", "WebSite", "WebApplication"]);
  });

  it("is written so no catalog text can close its script", () => {
    const head = pageHead({
      title: "t",
      url: `${SITE_URL}/`,
      image: `${SITE_URL}/og/image.png`,
      structuredData: { name: "</script><script>alert(1)</script>" },
    });
    const [script] = head.scripts;
    expect(script?.children).not.toContain("<");
    expect(JSON.parse(script?.children ?? "")).toEqual({
      name: "</script><script>alert(1)</script>",
    });
  });
});
