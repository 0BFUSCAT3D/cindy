// @cindy/mcps types refer to its Vite browser recipe module. The terminal imports
// only the helper factory: no Vite recipe loader executes in this Node host.
interface ImportMeta {
  glob(pattern: string | string[], options: { query: string; import: string; eager: true }): Record<string, unknown>;
}
