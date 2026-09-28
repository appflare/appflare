import type { ReactNode } from "react";
import {
  Address,
  AppTile,
  Canvas,
  type CardApp,
  colors,
  Logo,
  MARK_WHITE,
  Subline,
  Title,
} from "./cards.tsx";

/**
 * The social preview images of the three GitHub repositories, in the same
 * family as the site's cards but at GitHub's 1280x640: the logo, the line
 * that says what the repository is, and a picture of the product on the
 * right. GitHub has no API for them; `scripts/social-previews.ts` writes them
 * to `docs/assets/`, and the maintainer uploads each one by hand.
 */

export const SOCIAL_WIDTH = 1280;
export const SOCIAL_HEIGHT = 640;

export type SocialPreview =
  | {
      repo: "appflare";
      /** The manager's Home screenshot, as a data URI. */
      screenshot: string;
    }
  | { repo: "catalog"; apps: CardApp[]; count: number }
  | { repo: "deploy" };

const TEXT = 560;

export function socialPreviewElement(preview: SocialPreview): ReactNode {
  switch (preview.repo) {
    case "appflare":
      return (
        <Layout
          repo="appflare/appflare"
          title="The app manager for your own Cloudflare account"
          line="One Worker in your account installs apps built for Workers and keeps them updated."
        >
          <Screenshot src={preview.screenshot} />
        </Layout>
      );
    case "catalog":
      return (
        <Layout
          repo="appflare/catalog"
          title="The catalog of apps Appflare installs"
          line={`${preview.count} apps built for Workers, each built from a pinned upstream commit and signed.`}
        >
          <IconWall apps={preview.apps} />
        </Layout>
      );
    case "deploy":
      return (
        <Layout
          repo="appflare/deploy"
          title="Deploy Appflare to your Cloudflare account"
          line="One click puts a prebuilt Appflare in your account and opens the setup wizard."
        >
          <DeployPicture />
        </Layout>
      );
  }
}

function Layout({
  repo,
  title,
  line,
  children,
}: {
  repo: string;
  title: string;
  line: string;
  children: ReactNode;
}) {
  return (
    <Canvas style={{ padding: "72px 88px 60px", overflow: "hidden" }}>
      {children}
      <Logo height={50} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          flexGrow: 1,
          gap: 24,
        }}
      >
        <Title width={TEXT} lines={3} max={62} min={46} style={{ textAlign: "left" }}>
          {title}
        </Title>
        <Subline width={TEXT - 40} lines={3} max={27} min={22} style={{ textAlign: "left" }}>
          {line}
        </Subline>
      </div>
      <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
        <Address path="" size={24} />
        <span style={{ fontSize: 24, color: colors.line }}>/</span>
        <span style={{ fontSize: 24, color: colors.muted }}>github.com/{repo}</span>
      </div>
    </Canvas>
  );
}

/** A window on the right, bleeding off the edges, with a crop of the manager's Home. */
function Screenshot({ src }: { src: string }) {
  // The screenshot is 2352x1384; at 0.8 the "Your apps" tiles stay readable
  // when GitHub shows the preview at half size.
  const scale = 0.8;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        position: "absolute",
        left: 700,
        top: 96,
        width: 680,
        height: 640,
        borderRadius: 18,
        border: "1px solid rgba(0,0,0,0.1)",
        backgroundColor: "#fafafa",
        boxShadow: "0 30px 60px -20px rgba(0,0,0,0.25)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "14px 18px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: "rgba(0,0,0,0.12)" }}
          />
        ))}
      </div>
      <div style={{ display: "flex", position: "relative", flexGrow: 1, overflow: "hidden" }}>
        <img
          src={src}
          width={Math.round(2352 * scale)}
          height={Math.round(1384 * scale)}
          alt=""
          style={{ position: "absolute", left: -84, top: -596 }}
        />
      </div>
    </div>
  );
}

/** App icons in rows on the right, running off the edge. */
function IconWall({ apps }: { apps: CardApp[] }) {
  const size = 112;
  const gap = 26;
  const rows = [0, 1, 2, 3, 4].map((row) => apps.slice(row * 5, row * 5 + 5));
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        position: "absolute",
        left: 720,
        top: -38,
      }}
    >
      {rows.map((row, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows never reorder
          key={i}
          style={{ display: "flex", gap, marginLeft: i % 2 === 0 ? 0 : (size + gap) / 2 }}
        >
          {row.map((app) => (
            <AppTile key={app.name} app={app} size={size} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The mark on its dark tile, as an app's icon would sit, with the account it lands in. */
function DeployPicture() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 34,
        position: "absolute",
        left: 760,
        top: 150,
        width: 440,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 240,
          height: 240,
          borderRadius: 58,
          backgroundColor: colors.ink,
          boxShadow: "0 30px 60px -20px rgba(0,0,0,0.35)",
        }}
      >
        <img src={MARK_WHITE} width={150} height={150} alt="" />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 24px",
          borderRadius: 999,
          border: `1px solid ${colors.line}`,
          backgroundColor: "#ffffff",
          fontSize: 24,
          color: colors.muted,
        }}
      >
        <div style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: colors.flare }} />
        <span>Your account, your plan</span>
      </div>
    </div>
  );
}
