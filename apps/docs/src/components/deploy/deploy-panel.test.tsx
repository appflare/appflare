import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeployView } from "../../deploy/flow.ts";
import { CallbackPanel } from "./callback-panel.tsx";
import { createdItems, DeployPanel, JourneyRail, NO_ACTIONS, stageOf } from "./deploy-panel.tsx";
import { InstallerTerms, OtherWays } from "./deploy-shell.tsx";
import { SAMPLE_CALLBACK_VIEWS, SAMPLE_SECRETS, SAMPLE_VIEWS } from "./sample-views.ts";

function render(view: DeployView, canGoBack = true): string {
  return renderToStaticMarkup(
    <>
      <JourneyRail view={view} />
      <DeployPanel view={view} actions={NO_ACTIONS} canGoBack={canGoBack} />
    </>,
  );
}

/** Visible text, roughly: tags removed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("DeployPanel", () => {
  it.each(Object.entries(SAMPLE_VIEWS))("draws %s without showing a secret", (_name, view) => {
    const html = render(view);
    expect(html.length).toBeGreaterThan(50);
    expect(html).not.toContain(SAMPLE_SECRETS.key);
    expect(html).not.toContain(SAMPLE_SECRETS.handoffSecret);
    // The owner claim appears only as the target of the Open link.
    const claims = html.split(SAMPLE_SECRETS.claim).length - 1;
    expect(claims).toBe(view.step === "opening" ? 1 : 0);
    expect(text(html)).not.toContain(SAMPLE_SECRETS.claim);
  });

  it("marks the current stage of the journey", () => {
    const html = render(SAMPLE_VIEWS.review as DeployView);
    expect(html).toMatch(/aria-current="step"[^>]*>.*Review/);
    expect(stageOf(SAMPLE_VIEWS["confirm-remove"] as DeployView)).toBeNull();
  });

  it("starts with Connect Cloudflare and lists every permission on demand", () => {
    const html = render(SAMPLE_VIEWS.welcome as DeployView);
    expect(html).toContain(">Connect Cloudflare<");
    const details = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(details).toContain("workers-scripts.write");
    expect(details).toContain("offline_access");
  });

  it("reviews the account, name, complete address, release and what gets created", () => {
    const t = text(render(SAMPLE_VIEWS.review as DeployView));
    for (const part of [
      "Acme Studio",
      "appflare",
      "https://appflare.acme.example",
      "Appflare 0.4.2",
      "a D1 database named appflare",
      "a KV namespace named appflare-kv",
      "a Workflow named appflare-jobs",
      "The custom domain appflare.acme.example",
      "Deploy Appflare",
    ]) {
      expect(t).toContain(part);
    }
  });

  it("names the Workflow after another name, and the workers.dev address without a domain", () => {
    expect(
      createdItems({
        workerName: "team",
        hostname: null,
        address: "https://team.acme.workers.dev",
      }),
    ).toEqual(
      expect.arrayContaining([
        "Its background jobs, a Workflow named team-jobs, and a schedule for its regular checks",
        "Its address on workers.dev, https://team.acme.workers.dev",
      ]),
    );
  });

  it("explains DNS and certificates while the domain keeps Appflare waiting, and offers workers.dev", () => {
    const t = text(render(SAMPLE_VIEWS["deploying-waiting"] as DeployView));
    expect(t).toContain("a DNS record");
    expect(t).toContain("security certificate");
    expect(t).toContain("Check now");
    expect(t).toContain("Open at workers.dev instead");
    expect(t).toContain("https://appflare.acme.workers.dev");
  });

  it("says what removing deletes, and that nothing else is touched", () => {
    const t = text(render(SAMPLE_VIEWS["confirm-remove"] as DeployView));
    expect(t).toContain("Appflare itself, a Worker named appflare");
    expect(t).toContain("Anything that was in the account before is left alone");
    expect(t).toContain("cannot be undone");
  });

  it("opens owner setup on the chosen address, with no referrer", () => {
    const html = render(SAMPLE_VIEWS.opening as DeployView);
    expect(html).toContain(
      `href="https://appflare.acme.example/setup#claim=${SAMPLE_SECRETS.claim}"`,
    );
    expect(html).toContain('rel="noreferrer"');
  });
});

describe("the deploy page's terms", () => {
  it("say what the installer receives and keeps, and offer the other ways", () => {
    const t = text(
      renderToStaticMarkup(
        <>
          <InstallerTerms />
          <OtherWays />
        </>,
      ),
    );
    expect(t).toContain("What Appflare's installer receives and keeps");
    expect(t).toContain("short-lived Cloudflare access token");
    expect(t).toContain("never receives the refresh token");
    expect(t).toContain("record is deleted when the owner account is created");
    expect(t).toContain("Deploy to Cloudflare button");
    expect(t).toContain("npx create-appflare");
  });
});

describe("CallbackPanel", () => {
  it.each(Object.entries(SAMPLE_CALLBACK_VIEWS))("draws %s", (_name, view) => {
    const html = renderToStaticMarkup(<CallbackPanel view={view} />);
    expect(html.length).toBeGreaterThan(50);
  });

  it("shows a reconnect's destination and asks first, without drawing the code", () => {
    const view = SAMPLE_CALLBACK_VIEWS["callback-confirm-return"] ?? { step: "working" };
    const html = renderToStaticMarkup(<CallbackPanel view={view} />);
    const t = text(html);
    expect(t).toContain("Return to your Appflare at");
    expect(t).toContain("https://appflare.acme.example");
    expect(t).toContain("only if this is your own Appflare's address");
    expect(t).toContain("Return to my Appflare");
    expect(t).toContain("Cancel");
    expect(html).not.toContain(SAMPLE_SECRETS.claim);
    expect(html).not.toContain("<form");
  });

  it("does not claim the reconnect worked: the Appflare says so", () => {
    const view = SAMPLE_CALLBACK_VIEWS["callback-returning"] ?? { step: "working" };
    const t = text(renderToStaticMarkup(<CallbackPanel view={view} />));
    expect(t).toContain("It shows whether Cloudflare is connected");
  });

  it("names missing permissions and sends the visitor back to start again", () => {
    const html = renderToStaticMarkup(
      <CallbackPanel
        view={SAMPLE_CALLBACK_VIEWS["callback-missing-scopes"] ?? { step: "working" }}
      />,
    );
    expect(html).toContain("dns.write, zone.read");
    expect(html).toContain('href="/deploy/"');
  });
});
