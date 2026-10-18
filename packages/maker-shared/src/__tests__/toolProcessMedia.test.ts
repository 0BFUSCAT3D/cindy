// User-requested process previews: native extraction + persisted refs used by both UIs.
// Unit coverage missing from delivered-media tests; image-only and mixed video are minimal inputs.
import { describe, it, expect } from "vitest";
import {
  collectNativeToolMedia,
  readToolProcessMedia,
  withToolProcessMedia,
} from "../toolProcessMedia";
describe("tool process media", () => {
  it("keeps MCP embedded video and Codex dynamic images", () => {
    expect(
      collectNativeToolMedia([
        {
          type: "resource",
          resource: { mimeType: "video/mp4", blob: "dmlkZW8=" },
        },
        { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
        { type: "text", text: "view /tmp/not-an-image.png" },
      ]),
    ).toEqual([
      { kind: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
      { kind: "image", url: "data:image/png;base64,aW1hZ2U=" },
    ]);
  });
  it("round trips media beside existing delivered results", () => {
    const refs = [
      {
        kind: "image" as const,
        url: "cindy-media://blobs/" + "a".repeat(64) + ".png",
      },
    ];
    const text = withToolProcessMedia(
      '{"xdt_video_url":"https://example.com/final.mp4"}',
      refs,
    );
    expect(readToolProcessMedia(text)).toEqual(refs);
    expect(JSON.parse(text).xdt_video_url).toBe(
      "https://example.com/final.mp4",
    );
  });
  it("rejects arbitrary native paths and active schemes in rendered metadata", () => {
    expect(
      readToolProcessMedia(
        JSON.stringify({
          cindy_process_media: [
            { kind: "image", url: "file:///etc/passwd" },
            { kind: "video", url: "javascript:alert(1)" },
          ],
        }),
      ),
    ).toEqual([]);
    expect(readToolProcessMedia("broken cindy_process_media")).toEqual([]);
  });
  it("keeps multilingual output within the remote byte budget without breaking the media JSON", () => {
    const refs = [
      { kind: "video" as const, url: "https://example.com/clip.mp4" },
    ];
    const text = withToolProcessMedia("截图说明😀".repeat(3000), refs);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192);
    expect(readToolProcessMedia(text)).toEqual(refs);
    expect(JSON.parse(text).text).toMatch(/^截图说明😀/);
  });
});
