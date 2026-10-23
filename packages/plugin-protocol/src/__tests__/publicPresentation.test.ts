// Public sharing DTO v1: parsing must discard private installation/owner data
// and reject incompatible input. Existing delivery DTO tests do not cover this
// public projection. Minimal unit inputs add one private field or malformed ID;
// no sockets, accounts or database are required.
import { describe, expect, it } from "vitest";
import { parsePublicPluginPresentation } from "../publicPresentation.js";

const publicView = {
  schemaVersion: 1,
  pluginId: "c123456789012345678901234",
  name: "Example",
  description: null,
  author: null,
  version: "1.0.0",
  publishedAt: "2026-10-15T00:00:00.000Z",
};
describe("public plugin presentation boundary", () => {
  it("keeps only public display fields even if an upstream includes installation or owner data", () => {
    expect(
      parsePublicPluginPresentation({
        ...publicView,
        manifest: { secret: "private" },
        packageUrl: "https://example.test/package",
        ownerPassportId: "owner",
        organizationId: "org",
      }),
    ).toEqual(publicView);
  });
  it.each([
    { schemaVersion: 2 },
    { pluginId: "../../private" },
    { name: "" },
    { publishedAt: "yesterday" },
  ])("rejects malformed or incompatible presentation: %o", (patch) => {
    expect(() =>
      parsePublicPluginPresentation({ ...publicView, ...patch }),
    ).toThrow();
  });
});
