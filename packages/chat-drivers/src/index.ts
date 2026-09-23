/**
 * @bushwhack/chat-drivers — reading bushwhack calls out of a chat page and answering into
 * its composer, one declarative driver per chat UI.
 *
 * No transport, no policy: give it a DOM and a driver spec. The grammar comes from
 * @bushwhack/protocol, so the page and the daemon cannot disagree on what a call is.
 */
import { META_AI } from './drivers/meta-ai.js';
import { GEMINI } from './drivers/gemini.js';
import { CHATGPT } from './drivers/chatgpt.js';
import { parseDriverSpec, type DriverSpec } from './spec.js';

export { DriverSpecSchema, parseDriverSpec, selectDriver, conversationId, chatPrompt, DriverSpecError } from './spec.js';
export type { DriverSpec } from './spec.js';

export { crossCheck, findCalls, finishedTurns, mayHoldCalls, callsInTurn, callsInMarkdown, blockText, readComposer, writeToComposer, attachImages, send } from './engine.js';
export type { FoundCall } from './engine.js';

/** The drivers shipped with the extension, validated like any other. */
export const DRIVERS: DriverSpec[] = [parseDriverSpec(META_AI), parseDriverSpec(GEMINI), parseDriverSpec(CHATGPT)];
