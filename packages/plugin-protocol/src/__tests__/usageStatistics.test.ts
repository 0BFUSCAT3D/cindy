import { expect, it } from "vitest";
import {
  parsePluginUsageStatistics,
  PLUGIN_API_SCHEMA_VERSION,
} from "../delivery.js";
const stats = {
  installationCount: "0",
  usageCount: "18446744073709551615",
  usageCountLast7Days: "20",
  asOf: "2026-10-12T00:00:00.000Z",
};
it("keeps real zero and large counters as exact strings without changing protocol v2", () => {
  expect(PLUGIN_API_SCHEMA_VERSION).toBe(2);
  expect(parsePluginUsageStatistics(stats)).toEqual(stats);
});
it("keeps absent, unsupported, download-only and malformed optional metrics unavailable", () => {
  for (const value of [
    undefined,
    null,
    {},
    { downloadCount: "400" },
    { ...stats, installationCount: 0 },
    { ...stats, usageCount: "-1" },
    { ...stats, asOf: "invalid" },
  ])
    expect(parsePluginUsageStatistics(value)).toBeUndefined();
});
