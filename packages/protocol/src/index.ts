/**
 * @bushwhack/protocol — the pseudo-MCP a web chat speaks: frontmatter call blocks in the
 * model's answer, result blocks in the operator's next message, tool specs and the
 * manifest that teaches the model both.
 *
 * Shared by the daemon (the authority: it types and runs calls) and the extension (which
 * only needs to know that a block is a finished call, and its id).
 */
export { scanCall, formatResult, formatResults, CALL_KEY, RESULT_KEY, END_LINE, ID_RE } from './grammar.js';
export type { Call, ScanResult, Result, Status } from './grammar.js';
export { bindArgs, ArgsError } from './tools.js';
export type { ToolSpec, ParamSpec, BodySpec, Args, ArgValue, Bound } from './tools.js';
export { renderManifest, exampleCall, CHAT_PROMPT_LIMITS } from './manifest.js';
export type { ManifestContext, ChatPrompt } from './manifest.js';
export { PORT_RANGE, rangePorts, BRIDGE, normalizePairingCode, EXTENSION_RELOAD, EXTENSION_NODE_PREFIX, CHAT, APPROVAL } from './bridge.js';
export type { SessionHealth, ToolsListRequest, ToolsListReply, ToolsCallRequest, ToolsCallReply, BridgeError, ChatSendRequest, ChatEvent, ChatTerminals, Picture, RefusedCall, ApprovalRequest, ApprovalVerdict } from './bridge.js';
export { extractFencedBlocks } from './markdown.js';
export { SPRITE, PALETTE } from './mascot.js';
