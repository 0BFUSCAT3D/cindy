import { isValidPluginResourceId } from "./internal/pluginResourceId.js";
import {
  isoDate,
  object,
  PluginProtocolError,
  string,
} from "./internal/parse.js";

/** Anonymous display contract. Deliberately excludes manifests, packages and owner identity. */
export interface PublicPluginPresentation {
  schemaVersion: 1;
  pluginId: string;
  name: string;
  description: string | null;
  author: string | null;
  version: string;
  publishedAt: string;
}

export function parsePublicPluginPresentation(
  value: unknown,
): PublicPluginPresentation {
  const row = object(value, "publicPlugin");
  if (row.schemaVersion !== 1 || !isValidPluginResourceId(row.pluginId)) {
    throw new PluginProtocolError("Unsupported public plugin presentation");
  }
  const nullableText = (value: unknown, path: string, max: number) =>
    value === null || value === "" ? null : string(value, path, max);
  return {
    schemaVersion: 1,
    pluginId: row.pluginId,
    name: string(row.name, "name", 256),
    description: nullableText(row.description, "description", 10_000),
    author: nullableText(row.author, "author", 256),
    version: string(row.version, "version", 128),
    publishedAt: isoDate(row.publishedAt, "publishedAt"),
  };
}
