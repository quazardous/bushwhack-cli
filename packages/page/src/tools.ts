/**
 * The page:* tool specs, and the envelope the daemon sends the extension to run one.
 *
 * The daemon owns the specs and the origins (from the app's routes); the extension owns
 * the tab and runs the action. The model never names an origin: page:open takes a path.
 */
import type { ToolSpec } from '@bushwhack/protocol';
import type { PageAction } from './types.js';

/** daemon → extension: a PageRequest; the extension answers with a PageOutcome. */
export const PAGE_ACT = 'page:act';
export const PAGE_REPLY = 'page:reply';

const selector = (description: string, required = true) =>
  ({ type: 'text', description, maxLength: 300, ...(required ? { required: true } : {}) }) as const;

export const PAGE_TOOLS: ToolSpec[] = [
  {
    name: 'page:open',
    summary: 'Open the app in the browser (its own tab), at a path. Other page:* tools act on that tab. The result says how the load went: its console errors and failed requests (a script or stylesheet missing, a CDN unreachable), or that there were none.',
    approval: false,
    params: { path: { type: 'text', description: 'a path on the app, like /about?x=1', maxLength: 500, default: '/' } },
    notes: [
      'In the app you build, do not use the browser\'s own dialogs (alert, confirm, prompt): they freeze the page until someone clicks, and here nobody does. Show messages and ask questions in the page itself — a message area, a dialog made of HTML.',
      'If the page opens one anyway, it is answered at once (OK; a prompt gets its default value) and shows in page:console as a `dialog` line.',
    ],
  },
  {
    name: 'page:snapshot',
    summary: 'What the page shows, as text: headings, text, links, buttons and fields, each with a CSS selector to act on.',
    approval: false,
    params: {},
  },
  {
    name: 'page:query',
    summary: 'The elements matching a CSS selector: tag, text, main attributes, position and size.',
    approval: false,
    params: { selector: selector('a CSS selector') },
  },
  { name: 'page:click', summary: 'Click the first element matching a CSS selector.', approval: false, params: { selector: selector('a CSS selector') } },
  {
    name: 'page:fill',
    summary: 'Type a value into a field (input, textarea, select), as a person would.',
    approval: false,
    params: { selector: selector('a CSS selector'), value: { type: 'text', description: 'the value', maxLength: 2000, required: true } },
  },
  {
    name: 'page:wait',
    summary: 'Wait until an element matching a selector appears, or for the page to settle when no selector is given.',
    approval: false,
    params: {
      selector: selector('a CSS selector', false),
      timeout: { type: 'int', description: 'seconds', min: 1, max: 30, default: 5 },
    },
  },
  { name: 'page:console', summary: 'The page’s last console messages, errors and native dialogs (alert, confirm, prompt) since it was opened.', approval: false, params: {} },
  { name: 'page:network', summary: 'The page’s last requests (method, URL, status, time) since it was opened.', approval: false, params: {} },
  {
    name: 'page:screenshot',
    summary: 'A picture of the page, or of one element, attached to the answer.',
    approval: false,
    params: { selector: selector('a CSS selector for one element; the whole page when absent', false) },
    notes: [
      'Describe only what the picture shows. If the result says `image: not attached`, you have no picture: do not describe the page from your code — read it with page:snapshot.',
    ],
  },
];

export function pageAction(tool: string): PageAction | undefined {
  const action = tool.startsWith('page:') ? tool.slice('page:'.length) : '';
  return PAGE_TOOLS.some((t) => t.name === tool) ? (action as PageAction) : undefined;
}
