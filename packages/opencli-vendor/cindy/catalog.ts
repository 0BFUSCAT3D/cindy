import manifestJson from '../cli-manifest.json';
import selection from './selection.json';
import type { Arg } from '../src/registry.js';

export interface CatalogEntry {
  site: string;
  name: string;
  description: string;
  access: 'read' | 'write';
  domain?: string;
  strategy?: string;
  browser?: boolean;
  args: Arg[];
  aliases?: string[];
  modulePath: string;
}

// Do not propagate the 1,223-entry JSON's inferred union through host types.
export const upstreamCatalog = manifestJson as CatalogEntry[];
export const excludedSites: Readonly<Record<string, string>> = selection.excludedSites;
export const canonicalCatalog = upstreamCatalog.filter(entry => !(entry.site in excludedSites));

/** Keep upstream aliases executable as well as canonical command names. */
const catalog: CatalogEntry[] = canonicalCatalog.flatMap(entry => [
  entry,
  ...(entry.aliases ?? []).map(name => ({ ...entry, name })),
]);
export default catalog;
