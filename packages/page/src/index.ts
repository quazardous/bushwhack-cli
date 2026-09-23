/**
 * @bushwhack/page — the page:* tools: the session app's tab, bounded DOM reading and
 * actions, and the origin check before and after each. Chrome sits behind `Browser`, so
 * all of it tests without a browser.
 */
export { PageController, LIMITS } from './controller.js';
export type { Browser, TabStore, TabInfo, PageRequest, PageOutcome, PageAction, RecordedEvents } from './controller.js';
export { allowed, originOf, urlFor } from './origin.js';
export { snapshotPage, queryPage, clickPage, fillPage, waitPage } from './dom.js';
export type { PageResult, QueriedElement } from './dom.js';
export * from './tools.js';
export { PAGE_ACTIONS } from './types.js';
