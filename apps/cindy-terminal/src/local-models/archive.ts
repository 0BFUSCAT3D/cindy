import { createReadStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import path from "node:path";
import * as tar from "tar";
import { findOllamaBinary } from "@cindy/model-providers/local-runtime/ollamaSidecar";
import { archivePath } from "../engines/archive.js";

/** Linux releases use zstd; no shell, system zstd or desktop runtime is needed. */
export async function extractLinuxOllama(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let invalid: unknown,
    bytes = 0,
    count = 0;
  const extract = tar.x({
    cwd: destination,
    strict: true,
    preservePaths: false,
    filter(name, entry) {
      try {
        const relative = archivePath(name);
        if (
          !("type" in entry) ||
          !["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(
            entry.type,
          )
        )
          throw new Error("UNSAFE_LOCAL_RUNTIME_ARCHIVE");
        if (entry.type === "SymbolicLink" || entry.type === "Link") {
          const link = entry.linkpath;
          if (
            !link ||
            /[\\:\x00-\x1f]/.test(link) ||
            path.posix.isAbsolute(link)
          )
            throw new Error("UNSAFE_LOCAL_RUNTIME_ARCHIVE");
          archivePath(
            path.posix.normalize(
              path.posix.join(
                entry.type === "Link" ? "" : path.posix.dirname(relative),
                link,
              ),
            ),
          );
        }
        bytes += entry.size;
        if (++count > 100_000 || bytes > 16 * 1024 ** 3)
          throw new Error("LOCAL_RUNTIME_ARCHIVE_TOO_LARGE");
      } catch (error) {
        invalid ??= error;
      }
      return !invalid;
    },
  });
  await pipeline(createReadStream(archive), createZstdDecompress(), extract, {
    signal,
  });
  if (invalid) throw invalid;
  signal?.throwIfAborted();
  const binary = findOllamaBinary(destination);
  if (!binary) throw new Error("LOCAL_RUNTIME_BINARY_MISSING");
  await chmod(binary, 0o755);
  return binary;
}
