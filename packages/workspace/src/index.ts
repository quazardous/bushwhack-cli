/**
 * @bushwhack/workspace — the project folder as the chat sees it: a realpath jail, ignore
 * rules that hide rather than filter, and the `fs:*` tools on top.
 */
export { Workspace, WorkspaceError, LIMITS, parseEdits, checkIgnoreRule } from './workspace.js';
export type { Edit } from './workspace.js';
export { IgnoreRules, isRuleFile, IGNORE_FILES } from './rules.js';
export { FS_TOOLS, runFsTool } from './tools.js';
