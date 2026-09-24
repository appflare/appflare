import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

// Kumo is replaced by a stand-in so the test inspects exactly what the wrapper hands it.
vi.mock("@cloudflare/kumo", () => ({ Tooltip: () => null }));

const { Tooltip, TOOLTIP_CONTENT_CLASS, tooltipContent } = await import("./tooltip");

type Props = { content?: ReactElement<{ className: string; children: unknown }>; side?: string };

describe("Tooltip", () => {
  it("caps the content at 20rem and lets it wrap", () => {
    expect(TOOLTIP_CONTENT_CLASS.split(" ")).toEqual(
      expect.arrayContaining(["max-w-80", "whitespace-normal"]),
    );
  });

  it("passes the capped content and every other prop to Kumo's Tooltip", () => {
    const element = Tooltip({ content: "A long explanation", side: "bottom", children: "x" });
    const { content, side } = (element as ReactElement<Props>).props;
    expect(side).toBe("bottom");
    expect(content?.props.className).toBe(TOOLTIP_CONTENT_CLASS);
    expect(content?.props.children).toBe("A long explanation");
  });

  it("caps content given to a field's label tooltip the same way", () => {
    const content = tooltipContent("Why") as ReactElement<{ className: string }>;
    expect(content.props.className).toBe(TOOLTIP_CONTENT_CLASS);
  });
});
