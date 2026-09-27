import { Grid, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import { AppIcon } from "../components/catalog-media";
import { OpenAppButton } from "../components/open-app-button";
import { StatusDot } from "../components/status-dot";
import { appLine } from "./app-line";
import { type AppSignal, homeName } from "./attention";
import type { HomeApp } from "./layout-data";

/**
 * Home's "Your apps": a card per install, by name, with its icon, its name
 * and one quiet line on its state (`appLine`), then Open (the app at its
 * address, in a new tab, when it has one) and Manage (its page here). One
 * column on a phone, with the buttons full width under the text.
 */
export function YourApps({
  apps,
  signals,
  now,
}: {
  apps: readonly HomeApp[];
  signals: ReadonlyMap<string, AppSignal>;
  now: Date;
}) {
  const sorted = [...apps].sort((a, b) =>
    homeName(a).localeCompare(homeName(b), undefined, { sensitivity: "base" }),
  );
  return (
    <section id="your-apps" aria-labelledby="your-apps-heading" className="grid scroll-mt-6 gap-3">
      <Text variant="heading" as="h2" id="your-apps-heading">
        Your apps
      </Text>
      <Grid variant="3up" gap="sm">
        {sorted.map((app) => (
          <AppCard key={app.id} app={app} signal={signals.get(app.id)} now={now} />
        ))}
      </Grid>
    </section>
  );
}

function AppCard({ app, signal, now }: { app: HomeApp; signal: AppSignal | undefined; now: Date }) {
  const name = homeName(app);
  return (
    <LayerCard
      data-app-card={app.id}
      data-app-name={name}
      className="flex h-full min-w-0 flex-col gap-4 px-4 py-4"
    >
      <div className="flex min-w-0 items-center gap-3">
        <AppIcon src={app.icon} name={app.name} size={40} />
        <div className="grid min-w-0 gap-0.5">
          <Text as="span" bold truncate>
            {name}
          </Text>
          {/* The line wraps (two lines at most) rather than hiding its end. */}
          <span className="flex min-w-0 items-start gap-1.5">
            {signal !== undefined && (
              <span className="flex h-lh items-center text-sm">
                <StatusDot signal={signal} />
              </span>
            )}
            <Text as="span" variant="secondary" size="sm">
              <span className="line-clamp-2 break-words">{appLine(app, signal, now)}</span>
            </Text>
          </span>
        </div>
      </div>
      <div className="mt-auto flex flex-col gap-2 *:w-full *:justify-center sm:flex-row sm:justify-end sm:*:w-auto">
        {app.address !== null && (
          <OpenAppButton href={app.address} label={name} size="sm" variant="primary" />
        )}
        <LinkButton
          href={`/apps/${app.id}`}
          size="sm"
          variant="secondary"
          aria-label={`Manage ${name}`}
        >
          Manage
        </LinkButton>
      </div>
    </LayerCard>
  );
}
