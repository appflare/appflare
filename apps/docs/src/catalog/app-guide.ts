import type { ServiceId } from "@appflare/schema";
import {
  countOf,
  licenseBadgeCopy,
  listWords,
  PLAN_WORDS,
  pluralOf,
  SERVICE_NAMES,
  SERVICE_NOUNS,
} from "@appflare/schema/catalog-display";
import { DEPLOY_PATH } from "../deploy/paths.ts";
import type { AskedField } from "./install-form.ts";
import type { SiteApp } from "./site-catalog.ts";
import { installPath } from "./urls.ts";

/**
 * The parts of an app's page that answer "how do I deploy <Name>": the
 * steps from no Appflare to a running app, what Appflare does that a deploy
 * by hand does not, and the questions people ask before they start. Every
 * sentence comes from the app's catalog entry, so no app needs copy of its
 * own; a fact the catalog does not give is left out rather than guessed.
 */

/**
 * The deploy page, told which app to open once Appflare is set up. The
 * `app` parameter is the deploy page's contract: it carries the app through
 * the setup and lands on the app's install form.
 */
export function deployAppPath(slug: string): string {
  return `${DEPLOY_PATH}?app=${encodeURIComponent(slug)}`;
}

/** The anchor of the page's "What it needs on your account" section. */
export const NEEDS_ANCHOR = "needs";

/**
 * "A self-hosted alternative to Google Analytics or Plausible", or null
 * when the catalog names nothing. The products join with "or": the app can
 * stand in for any one of them, which "and" would not say.
 */
export function alternativesLine(app: Pick<SiteApp, "alternativeTo">): string | null {
  if (app.alternativeTo.length === 0) return null;
  const products = new Intl.ListFormat("en", { type: "disjunction" }).format(app.alternativeTo);
  return `A self-hosted alternative to ${products}.`;
}

/** Step 1: Appflare itself, set up once per account. */
export interface SetupStep {
  title: string;
  text: string;
  /** The deploy page, carrying the app. */
  href: string;
  action: string;
  /** For someone who has Appflare already: the app's install page. */
  installHref: string;
  installQuestion: string;
  installAction: string;
}

/** Step 2: the app's install form. */
export interface InstallStep {
  title: string;
  /** What the person fills in; null when the catalog snapshot does not say. */
  asks: AskedField[] | null;
  /** The sentences after the fields: generated values, optional ones, Access, a build. */
  notes: string[];
}

/** Step 3, when the app has notes for after the install. */
export interface FinishStep {
  title: string;
  text: string;
}

export interface DeployGuide {
  title: string;
  setup: SetupStep;
  install: InstallStep;
  finish: FinishStep | null;
}

function setupText(app: Pick<SiteApp, "name" | "plan">): string {
  const base =
    "Appflare installs itself into your own Cloudflare account from your browser, " +
    "and runs on the free Workers plan";
  return app.plan === "free"
    ? `${base}, as ${app.name} does.`
    : `${base}. ${app.name} needs ${PLAN_WORDS.paid.name} on that account.`;
}

type Form = NonNullable<SiteApp["installForm"]>;

function accessNote(name: string, form: Form): string | null {
  const paths = form.publicPaths;
  const who =
    paths.length === 0
      ? "so only the people who use your Appflare can open it"
      : `so only the people who use your Appflare can open it, except ${listWords(paths)}, which ${paths.length === 1 ? "stays" : "stay"} public`;
  switch (form.access) {
    case "required":
      return `${name} is always installed behind Cloudflare Access, ${who}.`;
    case "recommended":
      return `The form puts ${name} behind Cloudflare Access, ${who}. You can switch that off.`;
    case "offered":
      return `One switch on the form puts ${name} behind Cloudflare Access, ${who}.`;
    case null:
      return null;
  }
}

function buildNote(tier: SiteApp["tier"]): string | null {
  switch (tier) {
    case "sandbox":
      return `It has no prebuilt release, so you approve a build of it in your account, on ${PLAN_WORDS.paid.name}.`;
    case "self-deploying":
      return `Its own installer deploys it, in your account on ${PLAN_WORDS.paid.name}, once you approve the run.`;
    case "artifact":
      return null;
  }
}

/** The token a self-deploying app's installer deploys with, which the form asks for first. */
function appTokenField(app: Pick<SiteApp, "name">): AskedField {
  return { label: `A Cloudflare API token for ${app.name}`, link: null, seedOnly: false };
}

/** A domain of the account for an app that receives email. */
const EMAIL_DOMAIN_FIELD: AskedField = {
  label: "A domain of yours that can receive email",
  link: null,
  seedOnly: false,
};

/** Everything the form asks for, in its order; null when the catalog snapshot does not say. */
function askedFields(app: SiteApp): AskedField[] | null {
  const form = app.installForm;
  if (form === null) return null;
  return [
    ...(app.tier === "self-deploying" ? [appTokenField(app)] : []),
    ...form.asks,
    ...(form.emailDomain ? [EMAIL_DOMAIN_FIELD] : []),
  ];
}

function installNotes(app: SiteApp, asks: readonly AskedField[] | null): string[] {
  const form = app.installForm;
  const notes: Array<string | null> = [];
  if (app.tier === "self-deploying") {
    notes.push(
      asks === null
        ? `It asks for a Cloudflare API token for ${app.name}, which its installer deploys with. Create token on its page in Appflare makes one.`
        : `Its installer deploys with that token, not Appflare's own. Create token on its page in Appflare makes one.`,
    );
  }
  if (form !== null && asks !== null) {
    if (asks.length === 0) notes.push(`${app.name} needs no keys or settings from you.`);
    if (form.generated.length > 0) {
      const values = countOf("value", form.generated.length);
      notes.push(`Appflare generates ${values} for you: ${listWords(form.generated)}.`);
    }
    if (form.optional > 0) {
      notes.push(
        `It also has ${countOf("optional setting", form.optional)} you can leave for later.`,
      );
    }
    notes.push(accessNote(app.name, form));
  }
  notes.push(buildNote(app.tier));
  return notes.filter((note) => note !== null);
}

/** The numbered steps from no Appflare to the app running in the visitor's account. */
export function deployGuide(app: SiteApp): DeployGuide {
  const steps = app.installForm?.postInstallSteps ?? 0;
  const asks = askedFields(app);
  return {
    title: `Deploy ${app.name} on Cloudflare`,
    setup: {
      title: "Set up Appflare in your Cloudflare account",
      text: setupText(app),
      href: deployAppPath(app.slug),
      action: "Set up Appflare",
      installHref: installPath(app.slug),
      installQuestion: "Already have Appflare?",
      installAction: `Install ${app.name}`,
    },
    install: {
      title: `Install ${app.name}`,
      asks,
      notes: installNotes(app, asks),
    },
    finish:
      steps === 0
        ? null
        : {
            title: "Finish setting it up",
            text: `After the install, Appflare shows ${countOf("short step", steps)} for ${app.name}, on its page.`,
          },
  };
}

/** One thing Appflare does that a deploy by hand does not. */
export interface WithAppflareItem {
  id: "setup" | "updates" | "health" | "account";
  title: string;
  text: string;
}

/**
 * What Appflare does that a deploy by hand does not, for the app's tier: an
 * app built in the account or deployed by its own installer updates only
 * after an approved run, and a self-deploying app's installer, not Appflare,
 * creates and deletes its resources and needs a token of its own.
 */
export function withAppflare(tier: SiteApp["tier"]): WithAppflareItem[] {
  const selfDeploying = tier === "self-deploying";
  return [
    {
      id: "setup",
      title: "Nothing to build on your computer",
      text: selfDeploying
        ? "Appflare sets itself up from your browser and runs the app's own installer in your Cloudflare account."
        : "Appflare sets itself up from your browser, with no API token to create and nothing to install.",
    },
    tier === "artifact"
      ? {
          id: "updates",
          title: "Updates in one click",
          text: "Appflare tells you when the catalog has a new version, and Update installs it.",
        }
      : {
          id: "updates",
          title: "Updates from the catalog",
          text: selfDeploying
            ? "Appflare tells you when the catalog has a new version, and runs the installer again once you approve."
            : "Appflare tells you when the catalog has a new version, and builds it in your account once you approve.",
        },
    {
      id: "health",
      title: "Health checks",
      text: "After every install and update, Appflare checks that the app answers.",
    },
    {
      id: "account",
      title: "It stays in your own account",
      text: selfDeploying
        ? "Everything runs on your Cloudflare account and your plan. An uninstall runs the app's installer to delete what it created."
        : "Everything runs on your Cloudflare account and your plan, and Appflare records what it creates, so an uninstall removes it.",
    },
  ];
}

/** One question of the page's FAQ, answered in plain text. */
export interface FaqItem {
  question: string;
  answer: string;
}

/** Services an install creates resources for; the others it only uses. */
const CREATED: ReadonlySet<ServiceId> = new Set<ServiceId>([
  "kv",
  "d1",
  "r2",
  "durable-objects",
  "hyperdrive",
  "vectorize",
  "queues",
  "pipelines",
  "workflows",
  "cron",
]);

function isService(id: string): id is ServiceId {
  return Object.hasOwn(SERVICE_NAMES, id);
}

/** A created service in a list: its resources in the plural ("KV namespaces"). */
function createdWords(id: ServiceId): string {
  const noun = SERVICE_NOUNS[id];
  return noun.countable ? pluralOf(noun.singular) : noun.name;
}

function planAnswer(app: Pick<SiteApp, "name" | "plan">): string {
  return app.plan === "free"
    ? `Yes. ${app.name} runs on Cloudflare's free Workers plan, and so does Appflare.`
    : `No. ${app.name} needs Cloudflare's ${PLAN_WORDS.paid.name} plan on your account. Appflare itself runs on the free plan.`;
}

function createsAnswer(app: SiteApp): string {
  if (app.tier === "self-deploying") {
    return `Appflare runs ${app.name}'s own installer in your account, and the installer creates what it needs. An uninstall runs the installer again to delete it all.`;
  }
  const services = app.services.filter(isService);
  const created = services.filter((id) => CREATED.has(id)).map(createdWords);
  const used = services.filter((id) => !CREATED.has(id)).map((id) => SERVICE_NOUNS[id]);
  const usedWords = used.map((noun) => (noun.countable ? countOf(noun.singular, 1) : noun.name));
  const parts = [
    created.length === 0
      ? `Appflare creates a Worker for ${app.name}.`
      : `Appflare creates a Worker for ${app.name} and the resources it uses: ${listWords(created)}.`,
  ];
  if (usedWords.length > 0) parts.push(`It also uses ${listWords(usedWords)}.`);
  if (app.tier === "sandbox" && services.length === 0) {
    parts.push("It is built in your account, so the rest is known then.");
  }
  parts.push(
    "Appflare records each resource it creates; an uninstall deletes them, keeping any data you choose to keep.",
  );
  return parts.join(" ");
}

function updateAnswer(app: Pick<SiteApp, "name" | "tier">): string {
  const offer = `When the catalog has a new version, ${app.name}'s page in Appflare says Update available.`;
  switch (app.tier) {
    case "artifact":
      return `${offer} Select Update: Appflare takes a snapshot first, so you can roll back to the version before. You can also let Appflare update it automatically.`;
    case "sandbox":
      return `${offer} Select Update and approve the build of the new version in your account. Appflare takes a snapshot first, so you can roll back to the version before.`;
    case "self-deploying":
      return `${offer} Select Update and approve the run: Appflare runs ${app.name}'s own installer again at the new version. Its installer changes the app in place, so there is no rollback.`;
  }
}

/**
 * Whether the app is open source, in the catalog's license words; null for
 * a license the catalog cannot place, where yes or no would be a guess.
 */
function licenseAnswer(app: Pick<SiteApp, "license" | "repo">): string | null {
  const copy = licenseBadgeCopy(app.license);
  const source = `Its source code is at github.com/${app.repo}.`;
  switch (copy.kind) {
    case "open-source":
      return `Yes, under ${copy.label}. ${copy.tooltip} ${source}`;
    case "source-available":
      return `Not quite: its code is public, but its license is source-available. ${copy.tooltip} ${source}`;
    case "none":
      return `No. ${copy.tooltip} ${source}`;
    case "unknown":
      return null;
  }
}

/**
 * The page's questions and answers, each answered from the catalog entry:
 * the plan, what the install creates, how updates work for its tier, and
 * its license when the catalog can say what kind it is.
 */
export function appFaq(app: SiteApp): FaqItem[] {
  const items: FaqItem[] = [
    { question: `Does ${app.name} run on Cloudflare's free plan?`, answer: planAnswer(app) },
    {
      question: `What does ${app.name} create in my Cloudflare account?`,
      answer: createsAnswer(app),
    },
    { question: `How do I update ${app.name}?`, answer: updateAnswer(app) },
  ];
  const license = licenseAnswer(app);
  if (license !== null) items.push({ question: `Is ${app.name} open source?`, answer: license });
  return items;
}
