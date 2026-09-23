import { describe, expect, it } from "vitest";
import { classifyHealthProbe, type HealthProbe, isEdge1042 } from "./health";

const res = (status: number, bodyStart = ""): HealthProbe => ({
  kind: "response",
  status,
  bodyStart,
});

describe("classifyHealthProbe", () => {
  it("retries the edge's 1042 page until the last attempt", () => {
    const edge = res(404, "error code: 1042\n");
    expect(isEdge1042(edge)).toBe(true);
    expect(classifyHealthProbe(edge, 1, 0).verdict).toBe("retry");
    expect(classifyHealthProbe(edge, 9, 16_000).verdict).toBe("retry");
    const last = classifyHealthProbe(edge, 10, 18_000);
    expect(last.verdict).toBe("unhealthy");
  });

  it("accepts an app's own 404 (not the 1042 page) as serving", () => {
    expect(classifyHealthProbe(res(404, "Not found"), 1, 0)).toEqual({
      verdict: "healthy",
      status: 404,
    });
  });

  it("retries DNS/connection errors", () => {
    const probe: HealthProbe = { kind: "error", message: "getaddrinfo ENOTFOUND" };
    expect(classifyHealthProbe(probe, 3, 4000).verdict).toBe("retry");
    expect(classifyHealthProbe(probe, 10, 18_000).verdict).toBe("unhealthy");
  });

  it("retries 5xx only during the first 20 seconds", () => {
    expect(classifyHealthProbe(res(503), 2, 2000).verdict).toBe("retry");
    expect(classifyHealthProbe(res(500), 6, 20_000).verdict).toBe("unhealthy");
  });

  it("accepts any other non-5xx answer", () => {
    expect(classifyHealthProbe(res(200), 1, 0).verdict).toBe("healthy");
    expect(classifyHealthProbe(res(302), 1, 0).verdict).toBe("healthy");
    expect(classifyHealthProbe(res(401), 1, 0).verdict).toBe("healthy");
  });
});
