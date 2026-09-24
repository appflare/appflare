import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ClipboardText,
  Empty,
  Input,
  LayerCard,
  LayerDialog,
  Radio,
  SensitiveInput,
  Text,
} from "@cloudflare/kumo";
import {
  BellSimpleIcon,
  CheckCircleIcon,
  KeyIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import {
  CHANNEL_KIND_DESCRIPTIONS,
  CHANNEL_KIND_LABELS,
  CHANNEL_KINDS,
  type ChannelKind,
  type ChannelSettings,
  type ChannelView,
  channelLabelSchema,
  channelSettingsSchema,
  DEFAULT_EVENTS,
  EVENT_DESCRIPTIONS,
  EVENT_LABELS,
  NOTIFICATION_COPY,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type TestResult,
} from "../notifications/channels";
import {
  createNotificationChannel,
  deleteNotificationChannel,
  replaceWebhookSigningSecret,
  sendTestNotification,
  updateNotificationChannel,
} from "../notifications/channels.functions";
import { ChannelKindLogo } from "./channel-logos";
import { ConfirmDialog } from "./confirm-dialog";
import { Timestamp } from "./timestamp";

/**
 * Settings, Notification channels (admins only): the channels, each with
 * its target, events, delivery health, "Send test", edit, and remove; a
 * generic webhook also replaces its signing secret. Credentials are entered
 * here and never shown again.
 */

const mono = "font-mono text-[0.9em]";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** "Add channel", which the page puts beside its title. */
export function AddChannelDialog() {
  return <ChannelDialog mode={{ kind: "add" }} />;
}

export function NotificationChannels({ channels }: { channels: ChannelView[] }) {
  return (
    <div className="grid gap-3">
      <Text variant="secondary">{NOTIFICATION_COPY.privacy}</Text>
      {channels.length === 0 ? (
        <Empty
          icon={<BellSimpleIcon size={48} className="text-kumo-inactive" />}
          title="No notification channels"
          description={NOTIFICATION_COPY.empty}
        />
      ) : (
        channels.map((channel) => <ChannelCard key={channel.id} channel={channel} />)
      )}
    </div>
  );
}

function statusBadge(channel: ChannelView) {
  if (!channel.readable) return <Badge variant="error">Credentials unreadable</Badge>;
  if (channel.failureCount > 0) {
    return (
      <Badge variant="warning">
        {channel.failureCount} failed attempt{channel.failureCount === 1 ? "" : "s"}
      </Badge>
    );
  }
  if (channel.lastSuccessAt !== null) return <Badge variant="success">Delivered</Badge>;
  return <Badge variant="neutral">Nothing sent yet</Badge>;
}

function ChannelCard({ channel }: { channel: ChannelView }) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const router = useRouter();

  async function onTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await sendTestNotification({ data: { id: channel.id } }));
      await router.invalidate();
    } catch (err) {
      setTest({ ok: false, detail: errorText(err, "Could not send the test message.") });
    }
    setTesting(false);
  }

  const events = channel.events.map((e) => EVENT_LABELS[e]);
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <ChannelKindLogo kind={channel.kind} size={18} />
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{channel.label}</span>
            <Text as="span" variant="secondary" size="sm">
              {CHANNEL_KIND_LABELS[channel.kind]}, <span className={mono}>{channel.target}</span>
            </Text>
          </span>
        </span>
        {statusBadge(channel)}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <div className="grid gap-1.5">
          <Text bold>Events</Text>
          <Text variant="secondary">
            {events.length === 0
              ? "None: this channel receives nothing until you pick events."
              : events.join(", ")}
          </Text>
        </div>
        <div className="grid gap-1.5">
          <Text bold>Deliveries</Text>
          <Text variant="secondary">
            Last delivered: <Timestamp iso={channel.lastSuccessAt} />.
            {channel.pending > 0 &&
              ` ${channel.pending} message${channel.pending === 1 ? " is" : "s are"} waiting to be sent or retried.`}
          </Text>
          {channel.failureCount > 0 && channel.lastError !== null && (
            <Text variant="secondary">
              {channel.failureCount} failed attempt{channel.failureCount === 1 ? "" : "s"} since the
              last delivery. Last error (<Timestamp iso={channel.lastFailureAt} />
              ): <span className={mono}>{channel.lastError}</span>
            </Text>
          )}
          {!channel.readable && (
            <Text variant="secondary">
              The stored credentials cannot be read, so nothing is sent. Edit the channel and enter
              its details again.
            </Text>
          )}
        </div>
        {test !== null && (
          <Banner
            variant={test.ok ? "default" : "error"}
            icon={test.ok ? <CheckCircleIcon weight="fill" /> : <WarningCircleIcon weight="fill" />}
            title={test.ok ? "Test message delivered" : "Test message not delivered"}
            description={test.ok ? undefined : test.detail}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<PaperPlaneTiltIcon />}
            loading={testing}
            onClick={() => void onTest()}
          >
            Send test
          </Button>
          <ChannelDialog mode={{ kind: "edit", channel }} />
          {channel.kind === "webhook" && channel.readable && (
            <SigningSecretDialog channel={channel} />
          )}
          <RemoveChannelDialog channel={channel} />
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}

type Mode = { kind: "add" } | { kind: "edit"; channel: ChannelView };

interface Fields {
  botToken: string;
  chatId: string;
  webhookUrl: string;
  url: string;
}

const EMPTY_FIELDS: Fields = { botToken: "", chatId: "", webhookUrl: "", url: "" };

function settingsOf(kind: ChannelKind, f: Fields): unknown {
  switch (kind) {
    case "telegram":
      return { kind, botToken: f.botToken, chatId: f.chatId };
    case "slack":
    case "discord":
      return { kind, webhookUrl: f.webhookUrl };
    case "webhook":
      return { kind, url: f.url };
  }
}

function anyEntered(kind: ChannelKind, f: Fields): boolean {
  switch (kind) {
    case "telegram":
      return f.botToken.trim() !== "" || f.chatId.trim() !== "";
    case "slack":
    case "discord":
      return f.webhookUrl.trim() !== "";
    case "webhook":
      return f.url.trim() !== "";
  }
}

const KIND_HELP: Record<ChannelKind, string> = {
  telegram:
    "Create a bot with BotFather, add it to the chat, and paste its token and the chat's id.",
  slack: "In Slack, add an incoming webhook to a channel and paste its URL.",
  discord: "In Discord, open the channel's settings, Integrations, Webhooks, and copy the URL.",
  webhook:
    "Appflare posts JSON to this URL and signs each body with a secret it shows you once, after saving. Your receiver verifies the signature over the raw body, rejects a stale sentAt, and ignores an id it has already seen.",
};

/**
 * Add a channel, or edit one (credentials are replaced only when entered
 * again). A channel whose credentials cannot be read any more needs its
 * details entered again; a webhook repaired this way gets a new signing
 * secret, shown once, as when it was added.
 */
function ChannelDialog({ mode }: { mode: Mode }) {
  const router = useRouter();
  const formId = useId();
  const editing = mode.kind === "edit" ? mode.channel : null;
  /** Editing a channel whose stored credentials are unreadable: they must be entered again. */
  const reenter = editing !== null && !editing.readable;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ChannelKind>(editing?.kind ?? "telegram");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [events, setEvents] = useState<string[]>([...(editing?.events ?? DEFAULT_EVENTS)]);
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setKind(editing?.kind ?? "telegram");
      setLabel(editing?.label ?? "");
      setEvents([...(editing?.events ?? DEFAULT_EVENTS)]);
      setFields(EMPTY_FIELDS);
      setErrors({});
      setFailure(null);
      setSecret(null);
    }
  }

  const set = (name: keyof Fields) => (value: string) => {
    setFields((f) => ({ ...f, [name]: value }));
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Record<string, string> = {};
    const labelCheck = channelLabelSchema.safeParse(label);
    if (!labelCheck.success) found.label = labelCheck.error.issues[0]?.message ?? "Check the name.";
    let settings: ChannelSettings | undefined;
    if (editing === null || reenter || anyEntered(kind, fields)) {
      const parsed = channelSettingsSchema.safeParse(settingsOf(kind, fields));
      if (parsed.success) settings = parsed.data;
      else {
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? "settings");
          found[key] ??= issue.message;
        }
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const picked = NOTIFICATION_EVENTS.filter((e) => events.includes(e)) as NotificationEvent[];
    setPending(true);
    setFailure(null);
    try {
      let saved: { signingSecret: string | null };
      if (editing === null) {
        if (settings === undefined) return;
        saved = await createNotificationChannel({ data: { label, events: picked, settings } });
      } else {
        saved = await updateNotificationChannel({
          data: {
            id: editing.id,
            label,
            events: picked,
            ...(settings === undefined ? {} : { settings }),
          },
        });
      }
      await router.invalidate();
      if (saved.signingSecret !== null) setSecret(saved.signingSecret);
      else setOpen(false);
    } catch (err) {
      setFailure(errorText(err, "Could not save the channel."));
    } finally {
      setPending(false);
    }
  }

  const keepHint = editing === null || reenter ? undefined : "Leave empty to keep the current one.";
  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Trigger
        render={(p) =>
          editing === null ? (
            <Button {...p} variant="primary" icon={<PlusIcon />}>
              Add channel
            </Button>
          ) : (
            <Button {...p} variant="secondary" icon={<PencilSimpleIcon />}>
              Edit
            </Button>
          )
        }
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>
          {secret !== null
            ? "Webhook signing secret"
            : editing === null
              ? "Add notification channel"
              : `Edit ${editing.label}`}
        </LayerDialog.Title>
        <LayerDialog.Description>
          {secret !== null
            ? NOTIFICATION_COPY.signingSecret
            : editing === null
              ? "Choose where Appflare sends messages, then the events it sends there."
              : reenter
                ? `The stored credentials cannot be read any more. Enter its details again to use it.${kind === "webhook" ? " The webhook gets a new signing secret, shown once after saving." : ""}`
                : "Change its name and events. Enter credentials only to replace the stored ones, which are never shown."}
        </LayerDialog.Description>
        <LayerDialog.Body>
          {secret !== null ? (
            <div className="grid gap-4">
              <ClipboardText text={secret} />
              <Banner
                variant="alert"
                icon={<WarningIcon weight="fill" />}
                title="Copy it now"
                description="Appflare stores it encrypted and never shows it again. Replace it from the channel if it is lost."
              />
            </div>
          ) : (
            <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
              {editing === null && (
                <Radio.Group
                  legend="Kind"
                  // How to get the credentials for the chosen kind, right under the choice.
                  description={KIND_HELP[kind]}
                  value={kind}
                  onValueChange={(v: string) => {
                    const next = CHANNEL_KINDS.find((k) => k === v);
                    if (next !== undefined) setKind(next);
                  }}
                  orientation="horizontal"
                  appearance="card"
                >
                  {CHANNEL_KINDS.map((k) => (
                    <Radio.Item
                      key={k}
                      value={k}
                      label={
                        <span className="flex items-center gap-2">
                          <ChannelKindLogo kind={k} />
                          {CHANNEL_KIND_LABELS[k]}
                        </span>
                      }
                      description={CHANNEL_KIND_DESCRIPTIONS[k]}
                    />
                  ))}
                </Radio.Group>
              )}
              <Input
                label="Name"
                value={label}
                onChange={(e) => setLabel(e.currentTarget.value)}
                autoComplete="off"
                maxLength={80}
                error={errors.label}
                placeholder="Team chat"
              />
              {kind === "telegram" && (
                <>
                  <SensitiveInput
                    label="Bot token"
                    autoComplete="off"
                    value={fields.botToken}
                    onValueChange={set("botToken")}
                    error={errors.botToken}
                    description={keepHint}
                  />
                  <Input
                    label="Chat id"
                    autoComplete="off"
                    spellCheck={false}
                    value={fields.chatId}
                    onChange={(e) => set("chatId")(e.currentTarget.value)}
                    error={errors.chatId}
                    description={
                      keepHint ??
                      "A number such as -1001234567890 for a group, or @name for a public channel."
                    }
                  />
                </>
              )}
              {(kind === "slack" || kind === "discord") && (
                <SensitiveInput
                  label={kind === "slack" ? "Incoming webhook URL" : "Webhook URL"}
                  autoComplete="off"
                  value={fields.webhookUrl}
                  onValueChange={set("webhookUrl")}
                  error={errors.webhookUrl}
                  description={keepHint ?? "The URL is a credential: anyone who has it can post."}
                />
              )}
              {kind === "webhook" && (
                <Input
                  label="URL"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://example.com/appflare"
                  value={fields.url}
                  onChange={(e) => set("url")(e.currentTarget.value)}
                  error={errors.url}
                  description={keepHint ?? NOTIFICATION_COPY.webhookAddress}
                />
              )}
              <Checkbox.Group
                legend="Events"
                description={`${EVENT_LABELS.health_failing}: ${EVENT_DESCRIPTIONS.health_failing}`}
                value={events}
                onValueChange={(v: string[]) => setEvents(v)}
              >
                {NOTIFICATION_EVENTS.map((e) => (
                  <Checkbox.Item key={e} value={e} label={EVENT_LABELS[e]} />
                ))}
              </Checkbox.Group>
              {failure !== null && (
                <Banner
                  variant="error"
                  icon={<WarningCircleIcon weight="fill" />}
                  title={failure}
                />
              )}
            </form>
          )}
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={secret !== null ? "Close" : "Cancel"}>
          {secret !== null ? (
            <LayerDialog.Actions.Primary onClick={() => setOpen(false)}>
              Done
            </LayerDialog.Actions.Primary>
          ) : (
            <LayerDialog.Actions.Primary type="submit" form={formId} loading={pending}>
              {editing === null ? "Add channel" : "Save"}
            </LayerDialog.Actions.Primary>
          )}
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/** A generic webhook's new signing secret, shown once; the old one stops working at once. */
function SigningSecretDialog({ channel }: { channel: ChannelView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setError(null);
      setSecret(null);
    }
  }

  async function onReplace() {
    setPending(true);
    setError(null);
    try {
      const saved = await replaceWebhookSigningSecret({ data: { id: channel.id } });
      setSecret(saved.signingSecret);
      await router.invalidate();
    } catch (err) {
      setError(errorText(err, "Could not replace the signing secret."));
    }
    setPending(false);
  }

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<KeyIcon />}>
            Replace signing secret
          </Button>
        )}
      />
      <LayerDialog.Content>
        <LayerDialog.Title>
          {secret === null ? "Replace signing secret" : "New signing secret"}
        </LayerDialog.Title>
        <LayerDialog.Description>
          {secret === null
            ? `Makes a new secret for ${channel.label}. The current one stops working at once, so update your receiver right after.`
            : NOTIFICATION_COPY.signingSecret}
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="grid gap-4">
            {secret !== null && <ClipboardText text={secret} />}
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={secret === null ? "Cancel" : "Close"}>
          {secret === null ? (
            <LayerDialog.Actions.Primary loading={pending} onClick={() => void onReplace()}>
              Replace
            </LayerDialog.Actions.Primary>
          ) : (
            <LayerDialog.Actions.Primary onClick={() => setOpen(false)}>
              Done
            </LayerDialog.Actions.Primary>
          )}
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function RemoveChannelDialog({ channel }: { channel: ChannelView }) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary-destructive" icon={<TrashIcon />}>
          Remove
        </Button>
      )}
      title={`Remove ${channel.label}`}
      description="Appflare stops sending to this channel and deletes its stored credentials. Messages waiting for a retry are dropped."
      confirmText={channel.label}
      actionLabel="Remove channel"
      onConfirm={async () => {
        await deleteNotificationChannel({ data: { id: channel.id } });
        await router.invalidate();
      }}
    />
  );
}
