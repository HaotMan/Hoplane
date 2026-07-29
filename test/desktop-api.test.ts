import { afterEach, describe, expect, it, vi } from "vitest";
import { api, post, remove } from "../apps/desktop/src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function successfulFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("desktop API client", () => {
  it("marks bodyless mutations as JSON so the local Core accepts same-origin UI requests", async () => {
    const fetchMock = successfulFetch();

    await remove("/v1/hosts/host-id");
    await post("/v1/hosts/host-id/logins/login-id/activate");

    for (const [, options] of fetchMock.mock.calls) {
      expect(new Headers(options?.headers).get("content-type")).toBe("application/json");
    }
  });

  it("does not add a content type to read-only requests", async () => {
    const fetchMock = successfulFetch();

    await api("/v1/hosts");

    const [, options] = fetchMock.mock.calls[0]!;
    expect(new Headers(options?.headers).has("content-type")).toBe(false);
  });

  it("preserves an explicitly supplied content type", async () => {
    const fetchMock = successfulFetch();

    await api("/v1/example", {
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain" }
    });

    const [, options] = fetchMock.mock.calls[0]!;
    expect(new Headers(options?.headers).get("content-type")).toBe("text/plain");
  });
});
