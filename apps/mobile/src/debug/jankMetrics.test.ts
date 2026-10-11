import { afterEach, describe, expect, it } from "vitest";
import {
  recordInvokeSent,
  recordPushHandled,
  setJankMetricsEnabled,
  setRemoteSessionStoreSizeSource,
  takeJankMetrics,
} from "./jankMetrics";

describe("jank metrics", () => {
  afterEach(() => setJankMetricsEnabled(false));

  it("records nothing while diagnostics are off", () => {
    recordPushHandled("local-db:messages:created", 5);
    setJankMetricsEnabled(true);
    expect(takeJankMetrics()).toMatchObject({
      pushCount: 0,
      invokeCount: 0,
      pushes: {},
      invokes: {},
    });
  });

  it("reports per-channel push time and request counts for one interval, then resets", () => {
    setJankMetricsEnabled(true);
    setRemoteSessionStoreSizeSource(() => ({
      sessions: 2,
      messages: 120,
      maxSessionMessages: 80,
      storeSubscribers: 40,
    }));
    recordPushHandled("local-db:messages:created", 4);
    recordPushHandled("local-db:messages:created", 10);
    recordPushHandled("maker:event", 1);
    recordInvokeSent("git-context:pr-status");
    recordInvokeSent("git-context:pr-status");

    expect(takeJankMetrics()).toEqual({
      store: {
        sessions: 2,
        messages: 120,
        maxSessionMessages: 80,
        storeSubscribers: 40,
      },
      pushCount: 3,
      pushMs: 15,
      pushes: {
        "local-db:messages:created": { count: 2, totalMs: 14, maxMs: 10 },
        "maker:event": { count: 1, totalMs: 1, maxMs: 1 },
      },
      invokeCount: 2,
      invokes: { "git-context:pr-status": 2 },
    });
    expect(takeJankMetrics()).toMatchObject({ pushCount: 0, invokeCount: 0 });
  });
});
