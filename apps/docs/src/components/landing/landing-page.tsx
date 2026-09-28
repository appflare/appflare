import { HomeLayout } from "@fumadocs/base-ui/layouts/home";
import Link from "fumadocs-core/link";
import type { ReactNode } from "react";
import { appPath, appsPath } from "../../catalog/urls.ts";
import { catalogRepositoryUrl, type LandingData, landingLinks } from "../../lib/landing.ts";
import { appsLink, baseOptions, DOCS_HOME, docsLink } from "../../lib/layout.shared.tsx";
import { repositoryUrl } from "../../lib/shared.ts";
import { AgentPrompt } from "../agent-prompt.tsx";
import { AppIcon } from "../catalog/tiles.tsx";
import { ClickHere } from "./click-here.tsx";
import { DeployButton, GhostButton, Shot, Wordmark } from "./parts.tsx";

const notAffiliated =
  "Appflare is an independent open-source project, not affiliated with, endorsed by, or sponsored by Cloudflare, Inc.";

/** The front page, `/`: the site's top bar over {@link LandingContent}. */
export function LandingPage({ data }: { data: LandingData }) {
  return (
    <HomeLayout {...baseOptions()} links={[docsLink, appsLink]}>
      <LandingContent data={data} />
    </HomeLayout>
  );
}

/**
 * The real Home screen as the hero under one line of copy and the Deploy
 * button, then the catalog's numbers, three steps, the best-known apps, what
 * Appflare does after an install, a closing call to action and a footer.
 */
export function LandingContent({ data }: { data: LandingData }) {
  return (
    <>
      <Hero data={data} />

      <section
        aria-label="The catalog in numbers"
        className="mx-auto w-full max-w-6xl px-4 md:px-6"
      >
        <dl className="m-0 grid grid-cols-2 border-fd-border border-b md:grid-cols-4">
          <Fact value={String(data.apps)} label="apps in the catalog" />
          <Fact value={String(data.categories)} label="categories" />
          <Fact value={String(data.freePlan)} label="run on Workers Free" />
          <Fact value="1" label="Worker to manage them" />
        </dl>
      </section>

      <HowItWorks data={data} />
      <Apps data={data} />
      <Features />

      <section className="mx-auto w-full max-w-6xl px-4 pb-24 md:px-6">
        <div className="grid justify-items-center gap-6 rounded-3xl border border-fd-border bg-fd-card px-6 py-16 text-center">
          <h2 className="m-0 text-balance font-semibold text-3xl tracking-tight md:text-4xl">
            Your account. Your apps. Kept up to date.
          </h2>
          <p className="m-0 max-w-xl text-fd-muted-foreground">
            The button deploys a prebuilt, signed Appflare and opens the setup wizard. It takes a
            few minutes and a Cloudflare API token.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <DeployButton size="lg" />
            <GhostButton href={DOCS_HOME} size="lg">
              Read the docs
            </GhostButton>
          </div>
        </div>
      </section>

      <LandingFooter />
    </>
  );
}

function Hero({ data }: { data: LandingData }) {
  return (
    <section className="relative isolate overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[22rem] -z-10 mx-auto h-[36rem] max-w-5xl rounded-full bg-[radial-gradient(closest-side,rgba(251,107,0,0.16),transparent)] blur-2xl dark:bg-[radial-gradient(closest-side,rgba(251,107,0,0.22),transparent)]"
      />
      <div className="mx-auto grid max-w-3xl justify-items-center gap-6 px-6 pt-16 text-center md:pt-24">
        <a
          href={repositoryUrl}
          className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-fd-muted-foreground text-sm hover:text-fd-foreground"
        >
          <span className="size-1.5 rounded-full bg-[#fb6b00]" />
          Open source, Apache-2.0
        </a>
        <h1 className="m-0 text-balance font-semibold text-4xl tracking-tight md:text-6xl">
          The app manager for your own Cloudflare account
        </h1>
        <p className="m-0 max-w-2xl text-balance text-fd-muted-foreground text-lg md:text-xl">
          Appflare is one Worker in your account. Pick from {data.apps} apps built for Workers,
          install one in a click, and keep it updated, with a rollback when you need one.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <span className="relative inline-flex">
            <DeployButton size="lg" />
            {/* The arrow's tip sits just before the button's left edge, level with its middle. A phone has no room beside the button. */}
            <ClickHere className="pointer-events-none absolute top-1/2 right-full mr-2 hidden w-44 -translate-y-[60%] text-fd-foreground opacity-60 md:block" />
          </span>
          <GhostButton href={appsPath} size="lg">
            Browse apps
          </GhostButton>
        </div>
        <div className="grid justify-items-center gap-2">
          <AgentPrompt kind="install" align="center" />
          <p className="m-0 text-fd-muted-foreground text-sm">
            Runs on the Workers free plan.{" "}
            <Link
              href={DOCS_HOME}
              className="font-medium text-fd-foreground underline underline-offset-4"
            >
              Read the docs
            </Link>
          </p>
        </div>
      </div>
      <div className="relative mx-auto mt-14 max-w-6xl px-4 md:mt-20 md:px-6 lg:pr-32">
        <Shot
          src="/screenshots/landing-home.png"
          alt="Appflare's Home: the sidebar with the apps installed, two updates that need attention, and six installed apps"
          width={2880}
          height={1800}
          eager
        />
        <img
          src="/screenshots/catalog-phone.png"
          alt="The catalog on a phone"
          width={780}
          height={1540}
          loading="lazy"
          decoding="async"
          className="absolute right-0 bottom-8 hidden w-48 rounded-[1.75rem] border-[6px] border-neutral-900 shadow-2xl lg:block"
        />
      </div>
    </section>
  );
}

function Fact({ value, label }: { value: string; label: string }) {
  return (
    <div className="grid gap-1 px-2 py-8 text-center">
      <dt className="order-2 text-fd-muted-foreground text-sm">{label}</dt>
      <dd className="order-1 m-0 font-semibold text-3xl tabular-nums tracking-tight">{value}</dd>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: string;
  title: string;
  lead: string;
}) {
  return (
    <div className="grid max-w-2xl gap-3">
      <p className="m-0 font-medium text-[#c75400] text-sm dark:text-[#ff8a3d]">{eyebrow}</p>
      <h2 className="m-0 text-balance font-semibold text-3xl tracking-tight md:text-4xl">
        {title}
      </h2>
      <p className="m-0 text-fd-muted-foreground text-lg">{lead}</p>
    </div>
  );
}

function HowItWorks({ data }: { data: LandingData }) {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-24 md:px-6">
      <SectionHeading
        eyebrow="How it works"
        title="Three steps, all in your browser"
        lead="Nothing runs anywhere but your own account, on your plan, under your limits."
      />
      <ol className="m-0 mt-12 grid list-none gap-4 p-0 md:grid-cols-3">
        <Step
          n={1}
          title="Deploy Appflare"
          text="The Deploy to Cloudflare button puts the manager into your account and opens the setup wizard. Afterwards Appflare updates itself."
        >
          <div className="flex flex-wrap gap-1.5 font-mono text-xs">
            {["Worker", "D1", "KV", "Workflow", "Cron"].map((item) => (
              <span
                key={item}
                className="rounded-md border border-fd-border bg-fd-background px-2 py-1"
              >
                {item}
              </span>
            ))}
          </div>
        </Step>
        <Step
          n={2}
          title="Install an app"
          text="Pick an app from the catalog. Appflare creates what it needs (databases, storage, queues, secrets, cron triggers) and records each one."
        >
          <div className="flex flex-wrap gap-2">
            {data.showcase.slice(0, 6).map((app) => (
              <span key={app.slug} className="flex" title={app.name}>
                <AppIcon src={app.icon} name={app.name} size={36} />
              </span>
            ))}
          </div>
        </Step>
        <Step
          n={3}
          title="Keep it updated"
          text="New versions show up on Home. Update in one click, or let Appflare update apps on its own; roll back to the version you had, or uninstall and remove everything it created."
        >
          <div className="flex items-center gap-2 text-sm">
            <span className="size-2 rounded-full bg-blue-500" />
            <span>Update available to 0.1.1</span>
          </div>
        </Step>
      </ol>
    </section>
  );
}

function Step({
  n,
  title,
  text,
  children,
}: {
  n: number;
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-4 rounded-2xl border border-fd-border bg-fd-card p-6">
      <span className="grid size-8 place-items-center rounded-full border border-fd-border bg-fd-background font-mono text-sm">
        {n}
      </span>
      <h3 className="m-0 font-semibold text-lg">{title}</h3>
      <p className="m-0 text-fd-muted-foreground">{text}</p>
      <div className="mt-auto pt-2">{children}</div>
    </li>
  );
}

function Apps({ data }: { data: LandingData }) {
  return (
    <section className="border-fd-border border-y bg-fd-card/60">
      <div className="mx-auto w-full max-w-6xl px-4 py-24 md:px-6">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHeading
            eyebrow="The catalog"
            title={`${data.apps} apps, ready to install`}
            lead="Short links, analytics, email, password vaults, notes, file sharing and more, each built from a pinned upstream commit and signed."
          />
          <GhostButton href={appsPath}>See all {data.apps} apps</GhostButton>
        </div>
        <ul className="m-0 mt-12 grid list-none grid-cols-3 gap-1 p-0 md:gap-2 lg:grid-cols-6">
          {data.showcase.map((app) => (
            <li key={app.slug}>
              <Link
                href={appPath(app.slug)}
                className="flex h-full flex-col items-center gap-3 rounded-xl px-1 py-4 text-center transition-colors hover:bg-fd-accent md:p-4"
              >
                <AppIcon src={app.icon} name={app.name} size={56} />
                <span className="grid gap-0.5">
                  <span className="font-medium text-sm">{app.name}</span>
                  <span className="text-fd-muted-foreground text-xs">{app.category ?? ""}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-24 md:px-6">
      <SectionHeading
        eyebrow="What you get"
        title="Everything after the install, handled"
        lead="Appflare owns each install, so it can do what a copied repository cannot."
      />
      <Link
        href={landingLinks.automaticUpdates}
        className="mt-12 grid gap-6 overflow-hidden rounded-2xl border border-fd-border bg-fd-card p-6 transition-colors hover:border-fd-foreground/20 md:grid-cols-[2fr_3fr] md:items-center md:gap-10 md:p-10"
      >
        <div className="grid gap-3">
          <h3 className="m-0 font-semibold text-2xl tracking-tight">Automatic updates</h3>
          <p className="m-0 text-fd-muted-foreground">
            Turn on automatic updates for every app, or app by app. Every 30 minutes Appflare checks
            the catalog and updates an app on its own when the new version needs nothing from you,
            with the same snapshot and checks as an update you start. One that needs a new secret or
            a confirmation waits for you on the app's page.
          </p>
          <p className="m-0 text-fd-muted-foreground">
            Appflare can update itself the same way, when no other job is running.
          </p>
        </div>
        <Shot
          src="/screenshots/settings-appflare-updates.png"
          alt="Settings, Updates: Automatically update apps, and Automatically update Appflare under Appflare version"
          width={2352}
          height={1700}
          chrome={false}
          imgClassName="aspect-[16/10]"
          className="shadow-none"
        />
      </Link>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <BigFeature
          title="Every install is a job with a log"
          text="Installs, updates and rollbacks run as durable Workflow jobs. The log shows each step and ends with a health check."
          href={landingLinks.health}
          shot="/screenshots/jobs-install-log.png"
          alt="An install job that verified the signed release, created a KV namespace, uploaded the Worker, and passed its health check"
          height={1354}
        />
        <BigFeature
          title="Every app has a page"
          text="Stars, plan, license, size, screenshots and what the app needs from your account, before you install it."
          href={landingLinks.installApps}
          shot="/screenshots/catalog-app.png"
          alt="EmDash's catalog page with its stars, plan, license, version and screenshots"
          height={1580}
        />
      </div>
      <ul className="m-0 mt-4 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
        <SmallFeature title="Signed builds" href={landingLinks.catalogHowItWorks}>
          Catalog CI builds every version from a pinned commit and signs it. Nothing installs unless
          the signature verifies.
        </SmallFeature>
        <SmallFeature title="Updates and rollbacks" href={landingLinks.updates}>
          A snapshot of the Worker version and each D1 database comes first, so you can go back.
        </SmallFeature>
        <SmallFeature title="Custom domains" href={landingLinks.domains}>
          Serve an app on a hostname in your own zone. Cloudflare creates the DNS record and the
          certificate.
        </SmallFeature>
        <SmallFeature title="Users and passkeys" href={landingLinks.users}>
          One owner, admins who change things, members who can only look. Sign in with a passkey.
        </SmallFeature>
        <SmallFeature title="Notifications" href={landingLinks.notifications}>
          Updates, finished jobs and failing health checks, sent to Telegram, Slack, Discord or a
          signed webhook.
        </SmallFeature>
        <SmallFeature title="Your apps outlive it" href={landingLinks.faq}>
          Installed apps are ordinary Workers. They keep running if the manager breaks or is
          removed.
        </SmallFeature>
      </ul>
    </section>
  );
}

function BigFeature({
  title,
  text,
  href,
  shot,
  alt,
  height,
}: {
  title: string;
  text: string;
  href: string;
  shot: string;
  alt: string;
  height: number;
}) {
  return (
    <Link
      href={href}
      className="group grid gap-6 overflow-hidden rounded-2xl border border-fd-border bg-fd-card p-6 pb-0 transition-colors hover:border-fd-foreground/20"
    >
      <div className="grid gap-2">
        <h3 className="m-0 font-semibold text-lg">{title}</h3>
        <p className="m-0 text-fd-muted-foreground">{text}</p>
      </div>
      <Shot
        src={shot}
        alt={alt}
        width={2352}
        height={height}
        chrome={false}
        imgClassName="aspect-[16/10]"
        className="-mb-px rounded-b-none shadow-none"
      />
    </Link>
  );
}

function SmallFeature({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="grid h-full gap-2 rounded-2xl border border-fd-border p-6 transition-colors hover:bg-fd-accent/40"
      >
        <h3 className="m-0 font-semibold">{title}</h3>
        <p className="m-0 text-fd-muted-foreground text-sm">{children}</p>
      </Link>
    </li>
  );
}

/** The front page's own footer, in small type. The docs pages have none. */
function LandingFooter() {
  const links: Array<[string, string]> = [
    ["Docs", DOCS_HOME],
    ["Apps", appsPath],
    ["Submit an app", landingLinks.submit],
    ["Security", landingLinks.security],
    ["GitHub", repositoryUrl],
    ["Catalog on GitHub", catalogRepositoryUrl],
    ["Privacy", landingLinks.privacy],
  ];
  return (
    <footer className="border-fd-border border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-10 gap-y-4 px-4 py-10 md:px-6">
        <div className="flex items-center gap-3">
          <Wordmark className="h-5" />
          <span className="text-fd-muted-foreground text-xs">
            A self-hosted app manager for Cloudflare.
          </span>
        </div>
        <nav aria-label="Site">
          <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-xs">
            {links.map(([text, href]) => (
              <li key={href}>
                <Link href={href} className="text-fd-muted-foreground hover:text-fd-foreground">
                  {text}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <p className="mx-auto m-0 w-full max-w-6xl px-4 pb-10 text-fd-muted-foreground text-xs md:px-6">
        Apache-2.0. {notAffiliated}
      </p>
    </footer>
  );
}
