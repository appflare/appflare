import { Badge, Button, Link, Radio, Text } from "@cloudflare/kumo";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  ACCOUNT_PLAN_COPY,
  ACCOUNT_PLANS,
  type AccountPlan,
  accountPlanSchema,
} from "../account/plan";
import { setAccountPlan } from "../account/plan.functions";
import { dashboardUrl } from "../cloudflare/dashboard-links";
import { DescriptionItem, DescriptionList } from "../components/description-list";
import { DocsLink } from "../components/docs-link";
import { Section, SectionBody } from "../components/section";
import { settingsSection } from "../components/settings-links";
import { Timestamp } from "../components/timestamp";
import {
  type CapabilitiesView,
  manualPlanControl,
  PLAN_LABELS,
  SOURCE_LABELS,
  unknownSentence,
} from "./capabilities";
import { recheckAccountCapabilities } from "./capabilities.functions";

/** Where an admin turns R2 on (the dashboard asks for a payment method once). */
const R2_DASHBOARD_PATH = "r2/overview";
/** Where an admin changes the Workers plan. */
const PLANS_PATH = "workers/plans";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DescriptionItem label={label}>
      <span className="grid gap-1">{children}</span>
    </DescriptionItem>
  );
}

function Value({ text, source }: { text: string; source: "Detected" | "Set by you" | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Text as="span">{text}</Text>
      {source !== null && (
        <Badge variant={source === "Detected" ? "info" : "neutral"}>{source}</Badge>
      )}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Text variant="secondary" size="sm">
      {children}
    </Text>
  );
}

function PlanRow({ view }: { view: CapabilitiesView }) {
  const { plan, source } = view.plan;
  const control = manualPlanControl(view);
  return (
    <Row label="Workers plan">
      <Value
        text={source === "default" ? "Not known, treated as Workers Free" : PLAN_LABELS[plan]}
        source={source === "default" ? null : SOURCE_LABELS[source]}
      />
      {/* A missing Billing: Read is named under the manual choice instead. */}
      {control.show && !control.billingHint && view.workersPlan?.state === "unknown" && (
        <Note>{unknownSentence(view.workersPlan, "plan")}</Note>
      )}
    </Row>
  );
}

/**
 * The Workers plan an admin sets, offered only while Appflare cannot detect
 * it; members see it without being able to change it.
 */
function ManualPlanChoice({
  view,
  value,
  onChange,
  disabled,
  isAdmin,
}: {
  view: CapabilitiesView;
  value: AccountPlan | null;
  onChange(next: string): void;
  disabled: boolean;
  isAdmin: boolean;
}) {
  const control = manualPlanControl(view);
  if (!control.show) return null;
  return (
    <div className="grid gap-2">
      <Radio.Group
        legend={ACCOUNT_PLAN_COPY.manualLegend}
        description={control.billingHint ? ACCOUNT_PLAN_COPY.billingHint : undefined}
        value={value ?? ""}
        onValueChange={(next: string) => onChange(next)}
        disabled={disabled}
        orientation="horizontal"
        appearance="card"
      >
        {ACCOUNT_PLANS.map((plan) => (
          <Radio.Item
            key={plan}
            label={ACCOUNT_PLAN_COPY.labels[plan]}
            description={ACCOUNT_PLAN_COPY.descriptions[plan]}
            value={plan}
          />
        ))}
      </Radio.Group>
      {!isAdmin && <Note>Only admins can change it.</Note>}
    </div>
  );
}

function R2Row({ view }: { view: CapabilitiesView }) {
  const { r2 } = view;
  if (r2 === null)
    return (
      <Row label="R2">
        <Value text="Not checked yet" source={null} />
      </Row>
    );
  if (r2.state === "unknown") {
    return (
      <Row label="R2">
        <Value text="Unknown" source={null} />
        <Note>{unknownSentence(r2, "r2")}</Note>
      </Row>
    );
  }
  return (
    <Row label="R2">
      <Value text={r2.state === "enabled" ? "Enabled" : "Not enabled"} source="Detected" />
      {r2.state === "not-enabled" && (
        <Note>
          Apps that store files in R2 cannot be installed until it is on.{" "}
          <Link
            href={dashboardUrl(view.accountId, R2_DASHBOARD_PATH)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Enable R2 in the dashboard
            <Link.ExternalIcon />
          </Link>
        </Note>
      )}
    </Row>
  );
}

function ContainersRow({ view }: { view: CapabilitiesView }) {
  const { containers } = view;
  if (containers === null) {
    return (
      <Row label="Containers">
        <Value text="Not checked yet" source={null} />
      </Row>
    );
  }
  if (containers.state === "unknown") {
    return (
      <Row label="Containers">
        <Value text="Unknown" source={null} />
        <Note>{unknownSentence(containers, "containers")}</Note>
      </Row>
    );
  }
  return (
    <Row label="Containers">
      <Value
        text={containers.state === "available" ? "Available" : "Need Workers Paid"}
        source="Detected"
      />
      {containers.state === "needs-workers-paid" && (
        <Note>
          Sandbox builds and self-deploying apps run in containers.{" "}
          <Link
            href={dashboardUrl(view.accountId, PLANS_PATH)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Workers plans
            <Link.ExternalIcon />
          </Link>
        </Note>
      )}
    </Row>
  );
}

function ZoneRow({ view }: { view: CapabilitiesView }) {
  const { zone } = view;
  if (zone === null) {
    return (
      <Row label="Domains">
        <Value text="Not checked yet" source={null} />
      </Row>
    );
  }
  if (zone.state === "unknown") {
    return (
      <Row label="Domains">
        <Value text="Unknown" source={null} />
        <Note>{unknownSentence(zone, "zone")}</Note>
      </Row>
    );
  }
  return (
    <Row label="Domains">
      <Value
        text={
          zone.state === "available"
            ? "Active zone found"
            : "No active zone in this account (or the token lacks Zone: Read)"
        }
        source="Detected"
      />
      {zone.state === "none" && (
        <Note>Apps that answer on a domain or receive email need an active zone.</Note>
      )}
    </Row>
  );
}

function EmailRoutingRow({ view }: { view: CapabilitiesView }) {
  const { emailRouting, zone } = view;
  if (emailRouting === null) {
    return (
      <Row label="Email Routing">
        <Value text="Not checked yet" source={null} />
      </Row>
    );
  }
  if (emailRouting.state === "unknown") {
    return (
      <Row label="Email Routing">
        <Value text="Unknown" source={null} />
        <Note>
          {zone?.state === "unknown"
            ? "Appflare checks Email Routing on a domain of the account, and could not list the domains."
            : unknownSentence(emailRouting, "email-routing")}
        </Note>
      </Row>
    );
  }
  return (
    <Row label="Email Routing">
      <Value
        text={emailRouting.state === "available" ? "Available" : "Needs a domain"}
        source="Detected"
      />
    </Row>
  );
}

/**
 * The account capabilities section: what the Cloudflare token can tell about
 * the account (R2 enabled, Containers available, Workers plan, a domain,
 * Email Routing on it), each marked
 * "Detected" or "Set by you", and the Workers plan an admin sets for when it
 * cannot be detected. Admins can re-check at once; the token save and the
 * daily cron check too.
 */
export function AccountCapabilitiesCard({
  view,
  isAdmin,
}: {
  view: CapabilitiesView;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [manual, setManual] = useState<AccountPlan | null>(view.manualPlan);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRecheck() {
    setChecking(true);
    setError(null);
    try {
      await recheckAccountCapabilities();
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the account.");
    }
    setChecking(false);
  }

  async function onManualChange(next: string) {
    const parsed = accountPlanSchema.safeParse(next);
    if (!parsed.success || parsed.data === manual) return;
    const previous = manual;
    setManual(parsed.data);
    setSaving(true);
    setError(null);
    try {
      await setAccountPlan({ data: { plan: parsed.data } });
      await router.invalidate();
    } catch (err) {
      setManual(previous);
      setError(err instanceof Error ? err.message : "Could not save the Workers plan.");
    }
    setSaving(false);
  }

  return (
    <Section
      {...settingsSection("account", "capabilities")}
      titleAction={<DocsLink topic="capabilities" />}
      description="What the account can run, as Appflare's Cloudflare token reads it."
      action={
        isAdmin ? (
          <Button
            variant="secondary"
            icon={<ArrowClockwiseIcon />}
            loading={checking}
            onClick={onRecheck}
          >
            Re-check
          </Button>
        ) : null
      }
      error={error}
    >
      <SectionBody>
        <Text variant="secondary">
          Appflare reads these with its Cloudflare token when the token is saved, once a day, and
          when an admin chooses Re-check.{" "}
          {view.checkedAt === null ? (
            "They have not been checked yet."
          ) : (
            <>
              Last checked <Timestamp iso={view.checkedAt} />.
            </>
          )}
        </Text>
        <DescriptionList>
          <PlanRow view={view} />
          <R2Row view={view} />
          <ContainersRow view={view} />
          <ZoneRow view={view} />
          <EmailRoutingRow view={view} />
        </DescriptionList>
        <ManualPlanChoice
          view={view}
          value={manual}
          onChange={(next) => void onManualChange(next)}
          disabled={!isAdmin || saving}
          isAdmin={isAdmin}
        />
      </SectionBody>
    </Section>
  );
}
