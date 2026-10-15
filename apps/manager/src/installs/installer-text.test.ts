import { selfDeployingStage } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { installerAddresses, installerHelp, installerTextValues } from "./installer-text";

const INSTALL_ID = "01JZ8Q4W3M5N6P7R8S9T0V1X2Y";
const HELP =
  "Create a GitHub OAuth app whose callback URL is https://void-{{stage}}-api.{{workersDevSubdomain}}.workers.dev/auth/callback. Paste its client id here.";

describe("installer text", () => {
  const values = installerTextValues(INSTALL_ID, "acme");

  it("takes the stage from the install id the page made", () => {
    expect(values).toEqual({ stage: selfDeployingStage(INSTALL_ID), workersDevSubdomain: "acme" });
    expect(values.stage).toBe("appflare-9t0v1x2y");
    expect(installerTextValues(null, null)).toEqual({ stage: null, workersDevSubdomain: null });
  });

  it("fills in the help", () => {
    expect(installerHelp(HELP, values)).toBe(
      `Create a GitHub OAuth app whose callback URL is https://void-${values.stage}-api.acme.workers.dev/auth/callback. Paste its client id here.`,
    );
    expect(installerHelp(undefined, values)).toBeUndefined();
  });

  it("offers each address that names the stage, filled in, without the sentence's full stop", () => {
    expect(installerAddresses(HELP, values)).toEqual([
      `https://void-${values.stage}-api.acme.workers.dev/auth/callback`,
    ]);
    // Twice in the help: once to copy. A plain address is not offered.
    const twice = `${HELP} Again: https://void-{{stage}}-api.{{workersDevSubdomain}}.workers.dev/auth/callback, and see https://github.com/settings/developers.`;
    expect(installerAddresses(twice, values)).toHaveLength(1);
    expect(installerAddresses(undefined, values)).toEqual([]);
  });

  it("offers nothing half-filled while the subdomain is not known", () => {
    expect(installerAddresses(HELP, installerTextValues(INSTALL_ID, null))).toEqual([]);
  });
});
