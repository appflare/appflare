import { type ArtifactFixture, ZIP_URL } from "./artifact-fixture";

/**
 * Test-only stand-in for a release asset on GitHub: every request for the
 * zip answers 302 to a signed storage URL, which serves the bytes (Range
 * included). A request that asks fetch to follow redirects gets the storage
 * response marked `redirected`, the way the runtime reports the two hops.
 * Records every request (URL and Range) in order.
 */

export const STORAGE_URL = "https://release-assets.test/cut-1.0.0.zip?sig=test";

export interface HostRequest {
  url: string;
  range: string | null;
}

export function redirectingArtifactHost(fixture: ArtifactFixture) {
  const requests: HostRequest[] = [];
  const record = (url: string, init?: RequestInit) =>
    requests.push({ url, range: new Headers(init?.headers).get("range") });
  /** The response for `input`, or null when it is not the zip or its storage URL. */
  function serve(input: string, init?: RequestInit): Response | null {
    if (input === ZIP_URL) {
      record(input, init);
      if (init?.redirect === "manual") {
        return new Response(null, { status: 302, headers: { location: STORAGE_URL } });
      }
      record(STORAGE_URL, init);
      const followed = fixture.serve(ZIP_URL, init);
      if (followed !== null) Object.defineProperty(followed, "redirected", { value: true });
      return followed;
    }
    if (input === STORAGE_URL) {
      record(input, init);
      return fixture.serve(ZIP_URL, init);
    }
    return null;
  }
  return { serve, requests };
}
