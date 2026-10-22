import { describe, expect, it, vi } from "vitest";
import { RecipeBrowserSessions } from "./recipe-sessions.js";

describe("recipe browser sessions", () => {
  it("captures and drains responses across navigation without losing unfinished requests", async () => {
    const sessions = new RecipeBrowserSessions();
    let event: (
      method: string,
      params: Record<string, unknown>,
    ) => void = () => {};
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    let complete: (value: unknown) => void = () => {};
    const send = vi.fn(async (method: string) =>
      method === "Network.getResponseBody"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : {},
    );
    const id = sessions.begin("tab-one", {
      send,
      subscribe: (listener) => {
        event = listener;
        return unsubscribe;
      },
      dispose,
    });
    await sessions.call("tab-one", id, "Cindy.captureStart", {
      pattern: "/api/,/other/",
    });
    event("Network.requestWillBeSent", {
      requestId: "r",
      request: {
        url: "https://example.test/api/list",
        method: "POST",
        postData: "test",
      },
    });
    event("Network.responseReceived", {
      requestId: "r",
      response: { status: 200 },
    });
    event("Network.loadingFinished", { requestId: "r" });
    expect(
      await sessions.call("tab-one", id, "Cindy.captureRead", {
        retainIncomplete: true,
      }),
    ).toMatchObject({
      entries: [{ requestId: "r", responseStatus: 200, requestBody: "test" }],
    });
    complete({ body: '{"items":[1]}' });
    await vi.waitFor(async () => {
      expect(
        await sessions.call("tab-one", id, "Cindy.captureRead", {
          retainIncomplete: true,
        }),
      ).toMatchObject({
        entries: [{ captureComplete: true, responsePreview: '{"items":[1]}' }],
      });
    });
    expect(await sessions.call("tab-one", id, "Cindy.captureRead")).toEqual({
      entries: [],
    });
    await sessions.call("tab-one", id, "Cindy.end");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refuses cross-target access and commands that bypass navigation/upload policy", async () => {
    const sessions = new RecipeBrowserSessions();
    const send = vi.fn(async () => ({}));
    const id = sessions.begin("profile-a/tab-a", {
      send,
      subscribe: () => () => {},
      dispose: () => {},
    });
    try {
      await expect(
        sessions.call("profile-b/tab-b", id, "DOM.getDocument"),
      ).rejects.toThrow("unavailable");
      await expect(
        sessions.call("profile-a/tab-a", id, "DOM.setFileInputFiles"),
      ).rejects.toThrow("Unsupported");
      await expect(
        sessions.call("profile-a/tab-a", id, "Page.navigate"),
      ).rejects.toThrow("Unsupported");
      expect(send).not.toHaveBeenCalled();
    } finally {
      sessions.dispose();
    }
  });
});
