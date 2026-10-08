import { describe, expect, it } from "vitest";
import { alternativesLine, appFaq, deployAppPath, deployGuide, withAppflare } from "./app-guide.ts";
import { testApp, testForm } from "./test-app.ts";

describe("alternativesLine", () => {
  it("names the products the app can stand in for, any one of them", () => {
    expect(alternativesLine(testApp())).toBeNull();
    expect(alternativesLine(testApp({ alternativeTo: ["Bitly"] }))).toBe(
      "A self-hosted alternative to Bitly.",
    );
    expect(alternativesLine(testApp({ alternativeTo: ["Google Analytics", "Plausible"] }))).toBe(
      "A self-hosted alternative to Google Analytics or Plausible.",
    );
    expect(alternativesLine(testApp({ alternativeTo: ["A", "B", "C"] }))).toBe(
      "A self-hosted alternative to A, B, or C.",
    );
  });
});

describe("deployGuide", () => {
  it("sets up Appflare on the deploy page carrying the app, or installs into an existing one", () => {
    expect(deployAppPath("open-seo")).toBe("/deploy/?app=open-seo");
    const { title, setup } = deployGuide(testApp({ slug: "open-seo", name: "OpenSEO" }));
    expect(title).toBe("Deploy OpenSEO on Cloudflare");
    expect(setup.href).toBe("/deploy/?app=open-seo");
    expect(setup.installHref).toBe("/install/open-seo/");
    expect(setup.installAction).toBe("Install OpenSEO");
  });

  it("says which plan the app runs on", () => {
    expect(deployGuide(testApp()).setup.text).toMatch(/free Workers plan, as Cut does\.$/);
    expect(deployGuide(testApp({ plan: "paid" })).setup.text).toMatch(
      /free Workers plan\. Cut needs Workers Paid on that account\.$/,
    );
  });

  it("lists what the form asks for, and what it fills in or folds away", () => {
    const link = { label: "Get a key", url: "https://example.com/keys" };
    const { install } = deployGuide(
      testApp({
        installForm: testForm({
          asks: [{ label: "API key", link, seedOnly: false }],
          generated: ["Session secret", "Setup secret"],
          optional: 5,
          access: "required",
        }),
      }),
    );
    expect(install.title).toBe("Install Cut");
    expect(install.asks).toEqual([{ label: "API key", link, seedOnly: false }]);
    expect(install.notes).toEqual([
      "Appflare generates two values for you: Session secret and Setup secret.",
      "It also has five optional settings you can leave for later.",
      "Cut is always installed behind Cloudflare Access, so only the people who use your Appflare can open it.",
    ]);
  });

  it("says when the app needs nothing typed in, and how Access is offered", () => {
    const notes = (form: Parameters<typeof testForm>[0]) =>
      deployGuide(testApp({ installForm: testForm(form) })).install.notes;
    expect(notes({})).toEqual([
      "Cut needs no keys or settings from you.",
      "One switch on the form puts Cut behind Cloudflare Access, so only the people who use your Appflare can open it.",
    ]);
    expect(notes({ access: "recommended", generated: ["Key"], optional: 1 })).toEqual([
      "Cut needs no keys or settings from you.",
      "Appflare generates a value for you: Key.",
      "It also has an optional setting you can leave for later.",
      "The form puts Cut behind Cloudflare Access, so only the people who use your Appflare can open it. You can switch that off.",
    ]);
    expect(notes({ access: "offered", publicPaths: ["/s/*", "/api/hook"] })).toContain(
      "One switch on the form puts Cut behind Cloudflare Access, so only the people who use your Appflare can open it, except /s/* and /api/hook, which stay public.",
    );
  });

  it("asks an email app for a domain, and never says it needs nothing", () => {
    const { install } = deployGuide(
      testApp({ installForm: testForm({ emailDomain: true, access: null }) }),
    );
    expect(install.asks?.map((f) => f.label)).toEqual(["A domain of yours that can receive email"]);
    expect(install.notes).toEqual([]);
  });

  it("asks a self-deploying app for its own Cloudflare token", () => {
    const installer = deployGuide(
      testApp({ tier: "self-deploying", installForm: testForm({ access: null }) }),
    );
    expect(installer.install.asks?.map((f) => f.label)).toEqual(["A Cloudflare API token for Cut"]);
    expect(installer.install.notes).toEqual([
      "Its installer deploys with that token, not Appflare's own. Create token on its page in Appflare makes one.",
      "Its own installer deploys it, in your account on Workers Paid, once you approve the run.",
    ]);
    const unknown = deployGuide(testApp({ tier: "self-deploying" }));
    expect(unknown.install.asks).toBeNull();
    expect(unknown.install.notes[0]).toMatch(/^It asks for a Cloudflare API token for Cut/);
  });

  it("names no fields when the catalog does not say, and the build an app needs", () => {
    expect(deployGuide(testApp()).install).toEqual({ title: "Install Cut", asks: null, notes: [] });
    expect(deployGuide(testApp({ tier: "sandbox" })).install.notes).toEqual([
      "It has no prebuilt release, so you approve a build of it in your account, on Workers Paid.",
    ]);
  });

  it("has a last step only when Appflare shows notes after the install", () => {
    expect(deployGuide(testApp()).finish).toBeNull();
    expect(deployGuide(testApp({ installForm: testForm() })).finish).toBeNull();
    expect(
      deployGuide(testApp({ installForm: testForm({ postInstallSteps: 3 }) })).finish?.text,
    ).toBe("After the install, Appflare shows three short steps for Cut, on its page.");
    expect(
      deployGuide(testApp({ installForm: testForm({ postInstallSteps: 1 }) })).finish?.text,
    ).toBe("After the install, Appflare shows a short step for Cut, on its page.");
  });
});

describe("withAppflare", () => {
  const text = (tier: Parameters<typeof withAppflare>[0]) =>
    withAppflare(tier)
      .map((item) => `${item.title}. ${item.text}`)
      .join(" ");

  it("is a short list for every tier", () => {
    for (const tier of ["artifact", "sandbox", "self-deploying"] as const) {
      expect(withAppflare(tier).map((item) => item.id)).toEqual([
        "setup",
        "updates",
        "health",
        "account",
      ]);
    }
  });

  it("promises a one-click update only where no run needs approving", () => {
    expect(text("artifact")).toContain("Updates in one click");
    expect(text("sandbox")).not.toContain("one click");
    expect(text("self-deploying")).not.toContain("one click");
  });

  it("claims no token-free setup or Appflare-run removal for a self-deploying app", () => {
    expect(text("artifact")).toContain("no API token to create");
    expect(text("self-deploying")).not.toContain("API token");
    expect(text("self-deploying")).not.toContain("Appflare records what it creates");
    expect(text("self-deploying")).toContain("runs the app's installer to delete");
  });
});

describe("appFaq", () => {
  const answer = (app: ReturnType<typeof testApp>, start: string) =>
    appFaq(app).find((item) => item.question.startsWith(start))?.answer;

  it("asks three to five questions, each about the app", () => {
    const items = appFaq(testApp());
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(5);
    for (const item of items) expect(item.question).toContain("Cut");
  });

  it("answers the plan question from the app's plan", () => {
    expect(answer(testApp(), "Does Cut run")).toBe(
      "Yes. Cut runs on Cloudflare's free Workers plan, and so does Appflare.",
    );
    expect(answer(testApp({ plan: "paid" }), "Does Cut run")).toMatch(
      /^No\. Cut needs Cloudflare's Workers Paid plan/,
    );
  });

  it("says what the install creates and what it only uses", () => {
    const app = testApp({ services: ["kv", "d1", "cron", "workers-ai", "zone", "unknown-thing"] });
    expect(answer(app, "What does Cut create")).toBe(
      "Appflare creates a Worker for Cut and the resources it uses: KV namespaces, D1 databases and cron triggers. " +
        "It also uses Workers AI and a domain. " +
        "Appflare records each resource it creates; an uninstall deletes them, keeping any data you choose to keep.",
    );
    expect(answer(testApp(), "What does Cut create")).toMatch(
      /^Appflare creates a Worker for Cut\. /,
    );
    expect(answer(testApp({ tier: "self-deploying" }), "What does Cut create")).toMatch(
      /^Appflare runs Cut.s own installer in your account/,
    );
  });

  it("explains updates for the app's tier, with a rollback only where there is one", () => {
    expect(answer(testApp(), "How do I update")).toMatch(/roll back/);
    expect(answer(testApp({ tier: "sandbox" }), "How do I update")).toMatch(/approve the build/);
    expect(answer(testApp({ tier: "self-deploying" }), "How do I update")).toMatch(
      /there is no rollback\.$/,
    );
  });

  it("answers the license question in the catalog's words, and leaves out one it cannot place", () => {
    expect(answer(testApp(), "Is Cut open source")).toMatch(/^Yes, under MIT\. /);
    expect(
      answer(testApp({ license: { expression: "BUSL-1.1", note: null } }), "Is Cut open source"),
    ).toMatch(/^Not quite: its code is public, but its license is source-available\./);
    expect(
      answer(testApp({ license: { expression: "NONE", note: null } }), "Is Cut open source"),
    ).toMatch(/^No\. This project publishes no license\./);
    const own = testApp({ license: { expression: "LicenseRef-Cut", note: null } });
    expect(appFaq(own).map((item) => item.question)).not.toContain("Is Cut open source?");
    expect(answer(testApp(), "Is Cut open source")).toContain("github.com/acme/cut");
  });
});
