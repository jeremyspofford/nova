// M4 plugins, skills and slash commands (FR-045, FR-046; docs/08 §3-§4, §7): manifest loading and
// validation, the installer, catalogs, the skill index and plugin permissions. Only names that
// are specific to plugins and skills are exported; path and parsing helpers stay internal.
export type * from './types.ts';
export {
  FrontmatterError as SkillFrontmatterError,
  parseFrontmatterMarkdown,
  type ParsedMarkdown,
  type YamlValue,
} from './frontmatter.ts';
export {
  readCommandFile,
  readSkillFolder,
  SKILL_NAME,
  type ParsedSkill,
  type SkillParse,
} from './skill-file.ts';
export { expandPluginRoot, pluginHookContentHash, pluginHookScriptPaths } from './hook-hash.ts';
export {
  loadPluginFolder,
  loadPluginHooks,
  PLUGIN_MANIFEST_PATH,
  validatePluginHooksFile,
  validatePluginManifest,
  type LoadedPlugin,
  type LoadedPluginHook,
  type LoadedPluginRole,
  type LoadedPluginServer,
  type LoadedPluginSkill,
} from './manifest.ts';
export {
  applySkillPrecedence,
  buildSkillCatalog,
  parseSkillId,
  SKILL_CATALOG_MAX_TOKENS,
  SKILL_CATALOG_SHARE,
  SKILL_CATALOG_UNKNOWN_CHARS,
  skillCatalogChars,
  SkillIndex,
  toSkillView,
  type CreateSkillRequest,
  type IndexedSkill,
  type SkillIndexOptions,
  type SkillProjectFolder,
  type SkillRecord,
} from './skills.ts';
export {
  catalogKind,
  PluginCatalogs,
  spawnGit as spawnCatalogGit,
  type CatalogConfig,
  type CatalogIndex,
  type CatalogIndexEntry,
  type CatalogListing,
  type GitResult as CatalogGitResult,
  type GitRunner as CatalogGitRunner,
  type PluginCatalogsOptions,
} from './catalog.ts';
export {
  PLUGIN_PREVIEW_TTL_MS,
  PluginService,
  pluginHookId,
  pluginHookView,
  type InstallPluginRequest,
  type PluginHookChange,
  type PluginHookDefinition,
  type PluginHookSource,
  type PluginServerHost,
  type PluginServerRow,
  type PluginServiceOptions,
  type PluginSourceRequest,
  type PluginUiEntry,
} from './service.ts';
