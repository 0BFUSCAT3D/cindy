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
export const excludedCommands = new Set<string>(selection.excludedCommands);
// Local exports are outside the selected capability. Generation keeps its
// existing link-only branch; generic reading returns content in the tool result.
export const canonicalCatalog = upstreamCatalog.filter(entry => !(entry.site in excludedSites)
  && !excludedCommands.has(`${entry.site}/${entry.name}`)).map(entry => ({
    ...entry,
    args: entry.args.map(arg => ['sd', 'skip-download', 'no-download'].includes(arg.name)
      || (entry.site === 'web' && entry.name === 'read' && arg.name === 'stdout')
      ? { ...arg, default: true } : arg),
  }));

/** Keep upstream aliases executable as well as canonical command names. */
const catalog: CatalogEntry[] = canonicalCatalog.flatMap(entry => [
  entry,
  ...(entry.aliases ?? []).map(name => ({ ...entry, name })),
]);
export default catalog;
