import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeployView } from "../../deploy/flow.ts";
import { CallbackPanel } from "./callback-panel.tsx";
import {
  createdItems,
  DeployPanel,
  meterOf,
  NO_ACTIONS,
  showsIntro,
  stageOf,
} from "./deploy-panel.tsx";
import { InstallerTerms, journeyPosition, OtherWays } from "./deploy-shell.tsx";
import { SAMPLE_CALLBACK_VIEWS, SAMPLE_SECRETS, SAMPLE_VIEWS } from "./sample-views.ts";

function render(view: DeployView, canGoBack = true): string {
  return renderToStaticMarkup(
    <DeployPanel view={view} actions={NO_ACTIONS} canGoBack={canGoBack} />,
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

function sample(name: string): DeployView {
  const view = SAMPLE_VIEWS[name];
  if (view === undefined) throw new Error(`no sample ${name}`);
  return view;
}

describe("DeployPanel", () => {
  it.each(Object.entries(SAMPLE_VIEWS))("draws %s without showing a secret", (_name, view) => {
    const html = render(view);
    expect(html.length).toBeGreaterThan(50);
    expect(html).not.toContain(SAMPLE_SECRETS.key);
    expect(html).not.toContain(SAMPLE_SECRETS.handoffSecret);
    // The owner claim appears only as the target of the Open link.
    const claims = html.split(SAMPLE_SECRETS.claim).length - 1;
    expect(claims).toBe(view.step === "opening" && view.answering === "not-yet" ? 1 : 0);
    expect(text(html)).not.toContain(SAMPLE_SECRETS.claim);
    // Appflare's own loader, never a generic spinner.
    expect(html).not.toContain("animate-spin");
  });

  it("shows the installer's terms and the other ways to install only before Cloudflare", () => {
    for (const [name, view] of Object.entries(SAMPLE_VIEWS)) {
      const before = ["loading", "welcome", "welcome-resume"].includes(name);
      expect(showsIntro(view), name).toBe(before);
    }
  });

  it("counts no steps before Cloudflare is connected", () => {
    for (const name of ["loading", "welcome", "welcome-resume", "unavailable"]) {
      expect(meterOf(sample(name))).toBeNull();
      expect(render(sample(name))).not.toContain('role="meter"');
    }
  });

  it("shows a slim bar and the step's name after sign-in, the count only for screen readers", () => {
    const steps: Array<[string, string]> = [
      ["account", "Choose an account"],
      ["name", "Name"],
      ["address-domain", "Address"],
      ["review", "Review"],
    ];
    for (const [name, label] of steps) {
      const html = renderToStaticMarkup(
        <DeployPanel view={sample(name)} actions={NO_ACTIONS} canGoBack accountStep />,
      );
      expect(html).toContain('role="meter"');
      expect(text(html)).toContain(label);
      expect(text(html)).not.toMatch(/Step \d+ of \d+/);
    }
    // With several accounts: account 1, name 2, address 3, review 4, of 5 (the deploy is the last).
    const review = renderToStaticMarkup(
      <DeployPanel view={sample("review")} actions={NO_ACTIONS} canGoBack accountStep />,
    );
    expect(review).toMatch(/aria-valuenow="4"[^>]*|aria-valuemax="5"/);
    expect(review).toContain('aria-valuetext="Step 4 of 5"');
  });

  it("leaves no gap in the bar when there is no account to choose", () => {
    expect(journeyPosition("name", false)).toEqual({ step: 1, count: 4 });
    expect(journeyPosition("address", false)).toEqual({ step: 2, count: 4 });
    expect(journeyPosition("review", false)).toEqual({ step: 3, count: 4 });
    expect(journeyPosition("account", true)).toEqual({ step: 1, count: 5 });
    expect(journeyPosition("name", true)).toEqual({ step: 2, count: 5 });
    expect(render(sample("name"))).toContain('aria-valuetext="Step 1 of 4"');
  });

  it("hides the journey's bar from the deploy on, and outside the journey", () => {
    for (const name of ["deploying", "deploy-failed", "handing-off", "opening", "set-up"]) {
      expect(meterOf(sample(name))).toBeNull();
    }
    expect(stageOf(sample("confirm-remove"))).toBeNull();
    expect(render(sample("confirm-remove"))).not.toContain('role="meter"');
  });

  it("gives every step a title that can take the focus", () => {
    for (const view of Object.values(SAMPLE_VIEWS)) {
      expect(render(view)).toMatch(/<h1[^>]*><span id="deploy-step-title" tabindex="-1"/);
    }
  });

  it("offers to connect Cloudflare again, not to try again, when Appflare declined the connection", () => {
    const failed = sample("handoff-failed") as Extract<DeployView, { step: "handoff-failed" }>;
    const declined = text(render({ ...failed, problem: "declined" }));
    expect(declined).toContain("Connect Cloudflare again");
    expect(declined).not.toContain("Try again");
    const busy = text(render({ ...failed, problem: "busy" }));
    expect(busy).toContain("Try again");
    expect(busy).not.toContain("Connect Cloudflare again");
  });

  it("starts with Connect Cloudflare and keeps every permission behind a fold", () => {
    const html = render(sample("welcome"));
    const t = text(html);
    expect(t).toContain("Connect Cloudflare");
    expect(t).toContain("What Appflare asks Cloudflare for");
    // In the page for find-in-page, but folded away: each permission by name only.
    expect(html).toMatch(/<div[^>]*hidden[^>]*>(?:(?!<\/div>).)*Workers Scripts/s);
    expect(t).toContain("Offline access");
    expect(html).toContain('aria-label="Why Appflare needs Workers Scripts"');
    // The raw ids wait inside each Why? popover.
    expect(html).not.toContain("workers-scripts.write");
    expect(html).not.toContain("offline_access");
  });

  it("reviews the account, name, complete address and release, with what gets created on demand", () => {
    const t = text(render(sample("review")));
    for (const part of [
      "Acme Studio",
      "appflare",
      "https://appflare.acme.example",
      "Appflare 0.4.2",
      "Signature checked",
      "What gets created in Acme Studio",
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

  it("shows the step that runs, what it says about itself, and the finished steps on demand", () => {
    const html = render(sample("deploying"));
    const t = text(html);
    expect(t).toContain("Upload Appflare's files");
    expect(t).toContain("Uploaded 120 of 180 files.");
    // One bar: the deploy's own. Its number is the bar's (steps done); the step under way is named.
    expect(t).not.toContain("of 7");
    expect(t).toContain("Step 4 of 11");
    expect(t).toContain("3 of 11 done");
    expect(html).toMatch(/aria-valuenow="3"/);
    expect(html.match(/role="meter"/g)).toHaveLength(1);
    expect(t).toContain("Details");
    expect(t).toContain('Create the database: Created the D1 database "appflare".');
    expect(html).toContain('aria-busy="true"');
    // Progress is announced.
    expect(html).toMatch(
      /role="status"[^>]*>Step 4 of 11: Upload Appflare&#x27;s files\. 3 of 11 done\./,
    );
  });

  it("keeps a step's warning on screen in one line, from the deploy to owner setup", () => {
    for (const name of ["handing-off-notice", "opening-notice"]) {
      const html = render(sample(name));
      const t = text(html);
      expect(t).toContain(
        "Appflare's regular checks, such as looking for updates, will not run on their own.",
      );
      // The installer's full words, folded away.
      expect(t).toContain("Why");
      expect(html).toContain("free a trigger in another Worker");
    }
    expect(text(render(sample("opening")))).not.toContain("regular checks");
  });

  it("turns the progress into Reconnecting… when the installer does not answer", () => {
    const t = text(render(sample("deploying-reconnecting")));
    expect(t).toContain("Reconnecting…");
    expect(t).not.toMatch(/lost contact|tries again/);
    expect(t).not.toContain("Check now");
  });

  it("waits quietly while another window holds the installation, then explains it in one line", () => {
    const quiet = text(render(sample("deploying-held")));
    expect(quiet).toContain("Set up background jobs");
    expect(quiet).not.toContain("Another window");
    expect(quiet).not.toContain("Check now");
    const long = text(render(sample("deploying-held-long")));
    expect(long).toContain("Another window is working on this installation.");
    expect(long).toContain("Check now");
  });

  it("shows Check now busy while it checks, then what it found", () => {
    const checking = render(sample("deploying-address-checking"));
    expect(checking).toMatch(/<button[^>]*aria-busy="true"[^>]*>(?:(?!<\/button>).)*Checking…/s);
    // Busy but not disabled, so the focus stays on it; announced as checking.
    const button = /<button[^>]*aria-busy="true"[^>]*>/.exec(checking)?.[0] ?? "";
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(checking).toMatch(/role="status"[^>]*><span class="sr-only">Checking…<\/span>/);
    const checked = text(render(sample("deploying-address-checked")));
    expect(checked).toContain("Check now");
    expect(checked).toMatch(/Still waiting \(checked at .+\)\./);
  });

  it("explains the certificate wait in one line, and offers workers.dev only once it is long", () => {
    const early = text(render(sample("deploying-address")));
    expect(early).toContain(
      "Cloudflare is setting up appflare.acme.example and its certificate. This usually takes 1 to 5 minutes.",
    );
    expect(early).toContain("Check now");
    expect(early).not.toContain("workers.dev");
    const late = text(render(sample("deploying-waiting")));
    expect(late).toContain(
      "Rather not wait? Set up your owner account at workers.dev now; Appflare moves to appflare.acme.example once it is ready.",
    );
    expect(late).toContain("Open at workers.dev");
    expect(late).toContain("https://appflare.acme.workers.dev");
  });

  it("says what removing deletes, and that nothing else is touched", () => {
    const t = text(render(sample("confirm-remove")));
    expect(t).toContain("Appflare itself, a Worker named appflare");
    expect(t).toContain("Anything that was in the account before stays");
    expect(t).toContain("cannot be undone");
  });

  it("opens owner setup on the chosen address, with no referrer", () => {
    // While it checks, the page shows "Opening…" and no link that could land on a 404.
    expect(text(render(sample("opening")))).toContain("Opening…");
    expect(render(sample("opening"))).not.toContain("/setup#claim=");
    // When the address did not answer in time: Try again, or open it anyway.
    const html = render(sample("opening-not-yet"));
    expect(text(html)).toContain("Try again");
    expect(html).toContain(
      `href="https://appflare.acme.example/setup#claim=${SAMPLE_SECRETS.claim}"`,
    );
    expect(html).toContain('rel="noreferrer"');
  });
});

describe("the deploy page's terms", () => {
  it("say what the installer receives and keeps, and offer the other ways, folded away", () => {
    const html = renderToStaticMarkup(
      <>
        <InstallerTerms />
        <OtherWays />
      </>,
    );
    const t = text(html);
    expect(t).toContain("What Appflare's installer receives and keeps");
    expect(t).toContain("short-lived Cloudflare access token");
    expect(t).toContain("never gets the refresh token");
    expect(t).toContain("The record goes once the owner account is created");
    expect(t).toContain("Other ways to install");
    expect(t).toContain("Deploy to Cloudflare button");
    expect(t).toContain("npx create-appflare");
    // Both start folded.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });
});

describe("CallbackPanel", () => {
  it.each(Object.entries(SAMPLE_CALLBACK_VIEWS))("draws %s", (_name, view) => {
    const html = renderToStaticMarkup(<CallbackPanel view={view} />);
    expect(html.length).toBeGreaterThan(50);
    expect(html).not.toContain("animate-spin");
  });

  it("shows a reconnect's destination and asks first, without drawing the code", () => {
    const view = SAMPLE_CALLBACK_VIEWS["callback-confirm-return"] ?? { step: "working" };
    const html = renderToStaticMarkup(<CallbackPanel view={view} />);
    const t = text(html);
    expect(t).toContain("Return to your Appflare?");
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

  it("names missing permissions on demand and sends the visitor back to start again", () => {
    const html = renderToStaticMarkup(
      <CallbackPanel
        view={SAMPLE_CALLBACK_VIEWS["callback-missing-scopes"] ?? { step: "working" }}
      />,
    );
    expect(text(html)).toContain("2 of the permissions");
    expect(html).toContain("dns.write");
    expect(html).toContain("zone.read");
    expect(html).toContain('href="/deploy/"');
  });
});
