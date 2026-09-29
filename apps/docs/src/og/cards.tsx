import type { ReactNode } from "react";
import { ImageResponse } from "takumi-js/response";
import {
  Address,
  AppTile,
  type CardApp,
  Chip,
  type Crop,
  colors,
  IconWall,
  InstallPill,
  MarkTile,
  RepoAddress,
  Split,
  type SplitFrame,
  Window,
  YOUR_APPS_CROP,
} from "./base.tsx";
import type { OgPicture } from "./picture.ts";

/**
 * The site's OpenGraph cards, in the same system as the GitHub social
 * previews (`base.tsx`): the logo top left, a large left-aligned headline
 * and its sub-line, the page's address in the footer, and a picture of the
 * product on the right.
 *
 * Each card is 1200x630. Nothing runs closer than 64 pixels to the top and
 * bottom or 80 to the left, so the 1.91:1 crops of X, LinkedIn and Slack
 * lose nothing, and the square thumbnails some apps cut from the middle
 * still hold most of the headline and the picture beside it.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export type { CardApp } from "./base.tsx";

/** The manager's Home screenshot, as the docs pages link it. */
export const DASHBOARD = "/screenshots/home-dashboard.png";

/** A screenshot of the docs, with the address the pages use for it. */
export interface DocsPicture {
  path: string;
  picture: OgPicture;
}

export type OgCard =
  | {
      kind: "site";
      title: string;
      description: string;
      /** The manager's Home; null draws Appflare's mark instead. */
      dashboard: OgPicture | null;
    }
  | {
      kind: "docs";
      /** The heading of the part of the docs the page is in, if any. */
      section: string | null;
      title: string;
      description?: string | undefined;
      /** The page's path, shown after `appflare.dev` in the footer. */
      path: string;
      /** The first screenshot the page shows, else the manager's Home; null draws the mark. */
      screenshot: DocsPicture | null;
    }
  | {
      kind: "app";
      app: CardApp;
      categories: string[];
      path: string;
      /** The app's first screenshot; null draws its icon large. */
      screenshot: OgPicture | null;
    }
  | { kind: "install"; app: CardApp; path: string; screenshot: OgPicture | null }
  | {
      kind: "category";
      title: string;
      description: string;
      /** The category's apps, the ones the card shows first. */
      apps: CardApp[];
      path: string;
    }
  | { kind: "apps"; title: string; description: string; apps: CardApp[]; path: string };

/** A card as a 1200x630 PNG response. */
export function renderOgCard(card: OgCard): Response {
  return new ImageResponse(ogCardElement(card), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    format: "png",
  });
}

const FRAME: SplitFrame = {
  padding: "64px 80px 58px",
  logo: 46,
  text: 540,
  title: { lines: 3, max: 60, min: 42 },
  line: { width: 500, lines: 3, max: 26, min: 21 },
  gap: 22,
  footer: { size: 22, gap: 20 },
};

/** The install page's headline is a sentence, so it is drawn a size down. */
const INSTALL_FRAME: SplitFrame = {
  ...FRAME,
  title: { lines: 3, max: 54, min: 40 },
  line: { ...FRAME.line, lines: 2 },
};

/** Where a window with a screenshot sits: right of the words, running off the right and bottom edges. */
const WINDOW = { left: 652, top: 88, width: 640, height: 620 };
/** The height of the window's title bar. */
const BAR = 41;
/** The part of the window's content inside the card. */
const VIEW = { width: OG_WIDTH - WINDOW.left, height: OG_HEIGHT - WINDOW.top - BAR };
/** The middle of the space right of the words. */
const RIGHT_CENTRE = 915;

export function ogCardElement(card: OgCard): ReactNode {
  switch (card.kind) {
    case "site":
      return (
        <Split
          frame={FRAME}
          title={card.title}
          line={card.description}
          footer={<RepoAddress repo="appflare/appflare" size={FRAME.footer.size} />}
        >
          {card.dashboard === null ? (
            <MarkPicture />
          ) : (
            <Screenshot picture={card.dashboard} crop={YOUR_APPS_CROP} />
          )}
        </Split>
      );
    case "docs":
      return (
        <Split
          frame={FRAME}
          eyebrow={card.section ?? "Docs"}
          title={card.title}
          line={firstSentence(card.description ?? "")}
          footer={<Address path={card.path} size={FRAME.footer.size} />}
        >
          {card.screenshot === null ? (
            <MarkPicture />
          ) : (
            <Screenshot
              picture={card.screenshot.picture}
              crop={
                card.screenshot.path === DASHBOARD
                  ? YOUR_APPS_CROP
                  : docsCrop(card.screenshot.picture)
              }
            />
          )}
        </Split>
      );
    case "app":
      return (
        <Split
          frame={FRAME}
          title={card.app.name}
          line={card.app.pitch}
          extra={
            <>
              {card.categories.length > 0 && (
                <Row gap={10}>
                  {card.categories.slice(0, 3).map((label) => (
                    <Chip key={label} size={20}>
                      {label}
                    </Chip>
                  ))}
                </Row>
              )}
              <Row gap={0} style={{ marginTop: 6 }}>
                <InstallPill size={24} />
              </Row>
            </>
          }
          footer={<Address path={card.path} size={FRAME.footer.size} />}
        >
          {card.screenshot === null ? (
            <IconPicture app={card.app} />
          ) : (
            <Screenshot picture={card.screenshot} crop={appCrop(card.screenshot)} />
          )}
        </Split>
      );
    case "install":
      return (
        <Split
          frame={INSTALL_FRAME}
          title={`Install ${card.app.name}`}
          tail="in your Cloudflare account"
          line={card.app.pitch}
          extra={
            <Row gap={0} style={{ marginTop: 6 }}>
              <InstallPill size={24} />
            </Row>
          }
          footer={<Address path={card.path} size={FRAME.footer.size} />}
        >
          {card.screenshot === null ? (
            <InstallPicture app={card.app} />
          ) : (
            <ScreenshotWithIcon picture={card.screenshot} app={card.app} />
          )}
        </Split>
      );
    case "category":
      return (
        <Split
          frame={FRAME}
          eyebrow="Category"
          title={card.title}
          line={card.description}
          footer={<Address path={card.path} size={FRAME.footer.size} />}
        >
          <IconGrid apps={card.apps} />
        </Split>
      );
    case "apps":
      return (
        <Split
          frame={FRAME}
          eyebrow="Catalog"
          title={card.title}
          line={card.description}
          footer={<Address path={card.path} size={FRAME.footer.size} />}
        >
          <IconWall apps={card.apps} left={676} top={-44} size={108} gap={24} />
        </Split>
      );
  }
}

/** The first sentence of a description, which is what fits under a headline. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = /[.!?](?=\s+[A-Z0-9"'`(])/.exec(trimmed);
  return end === null ? trimmed : trimmed.slice(0, end.index + 1);
}

/**
 * The docs' screenshots are taken at twice their size: at 0.62 their text
 * reads as the page does, from the top-left corner. A narrow one (a phone)
 * is widened to fill the window, never past its own size.
 */
export function docsCrop(picture: OgPicture): Crop {
  const scale = picture.width * 0.62 >= VIEW.width ? 0.62 : Math.min(1, VIEW.width / picture.width);
  return { scale, x: 0, y: 0 };
}

/**
 * An app's own screenshot, fitted to the window's width so the whole of its
 * top shows, never scaled up past its own size.
 */
export function appCrop(picture: OgPicture): Crop {
  return { scale: Math.min(1, WINDOW.width / picture.width), x: 0, y: 0 };
}

/**
 * Where the window for a crop sits. A crop taller than the card shows runs
 * off the bottom edge; a shorter one gets a window its own height, centred
 * beside the words, rather than an empty one.
 */
export function windowFor(picture: OgPicture, crop: Crop) {
  const shown = Math.round(picture.height * crop.scale) - crop.y;
  if (shown >= VIEW.height - 24) return WINDOW;
  const height = shown + BAR;
  return { ...WINDOW, top: Math.round((OG_HEIGHT - height) / 2), height };
}

/** A screenshot in a window, placed by {@link windowFor}. */
function Screenshot({ picture, crop }: { picture: OgPicture; crop: Crop }) {
  return <Window picture={picture} crop={crop} {...windowFor(picture, crop)} />;
}

/** An app's screenshot, with its icon over the window's lower-left corner. */
function ScreenshotWithIcon({ picture, app }: { picture: OgPicture; app: CardApp }) {
  const crop = appCrop(picture);
  const window = windowFor(picture, crop);
  const size = 124;
  const top = Math.min(window.top + window.height - size + 28, OG_HEIGHT - size - 48);
  return (
    <>
      <Window picture={picture} crop={crop} {...window} />
      <div style={{ display: "flex", position: "absolute", left: window.left - 40, top }}>
        <AppTile app={app} size={size} />
      </div>
    </>
  );
}

function Row({
  gap,
  style,
  children,
}: {
  gap: number;
  style?: import("react").CSSProperties;
  children: ReactNode;
}) {
  return <div style={{ display: "flex", alignItems: "center", gap, ...style }}>{children}</div>;
}

/** Something centred in the space right of the words. */
function Right({ width, top, children }: { width: number; top: number; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "absolute",
        left: RIGHT_CENTRE - width / 2,
        top,
        width,
      }}
    >
      {children}
    </div>
  );
}

/** Appflare's mark, large, for a card without a screenshot. */
function MarkPicture() {
  return (
    <Right width={260} top={185}>
      <MarkTile size={260} />
    </Right>
  );
}

/** An app's icon, large, on a soft tile of its own. */
function IconPicture({ app }: { app: CardApp }) {
  const size = 400;
  return (
    <Right width={size} top={(OG_HEIGHT - size) / 2}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: 104,
          border: `1px solid ${colors.line}`,
          backgroundColor: "rgba(255,255,255,0.7)",
          backgroundImage:
            "radial-gradient(circle at 50% 40%, rgba(255,255,255,1) 0%, rgba(244,244,244,1) 100%)",
        }}
      >
        <AppTile app={app} size={236} />
      </div>
    </Right>
  );
}

/** The app, dots, and Appflare: what installing it does. */
function InstallPicture({ app }: { app: CardApp }) {
  return (
    <Right width={500} top={225}>
      <Row gap={22}>
        <AppTile app={app} size={180} />
        <Row gap={10}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: i === 2 ? colors.flare : "#d4d4d4",
              }}
            />
          ))}
        </Row>
        <MarkTile size={180} />
      </Row>
    </Right>
  );
}

/**
 * The first apps in a square grid: 3x3 for five apps or more, 2x2 for two to
 * four, one large tile for one. A place the apps do not fill stays a faint tile.
 */
function IconGrid({ apps }: { apps: CardApp[] }) {
  const cols = apps.length >= 5 ? 3 : apps.length >= 2 ? 2 : 1;
  const size = [220, 168, 124][cols - 1] ?? 124;
  const gap = cols === 3 ? 26 : 30;
  const places = Array.from({ length: cols }, (_, i) => i);
  const rows = places.map((row) => places.map((col) => apps[row * cols + col]));
  const side = size * cols + gap * (cols - 1);
  return (
    <Right width={side} top={(OG_HEIGHT - side) / 2}>
      <div style={{ display: "flex", flexDirection: "column", gap }}>
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows never reorder
          <Row key={i} gap={gap}>
            {row.map((app, j) =>
              app === undefined ? (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: the places never reorder
                  key={j}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: Math.round(size * 0.24),
                    border: `1px dashed ${colors.line}`,
                    backgroundColor: "rgba(255,255,255,0.5)",
                  }}
                />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: two apps may share a name
                <AppTile key={j} app={app} size={size} />
              ),
            )}
          </Row>
        ))}
      </div>
    </Right>
  );
}
