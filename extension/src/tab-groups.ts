/**
 * One tab group per session and window: the chats bound to a project and its app's tab
 * (page:*), side by side under the project's name.
 *
 * A chat tab follows the conversation it shows: navigating to another project's chat
 * moves it to that project's group, to an unbound one takes it out.
 *
 * The operator's arrangement wins: a tab they took out of the group is never put back,
 * a tab already in a group of theirs is never moved, and a group is never collapsed (a
 * chat only loads its message box in a visible tab).
 */

const COLORS = ['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'red', 'yellow', 'grey'] as const;
const NO_GROUP = -1;
const KEY = 'tabGroups';

export interface GroupState {
  /** `<session node id>@<window id>` → group id. */
  groups: Record<string, number>;
  /** Tabs this module put in a group, and which. */
  placed: Record<string, number>;
  /** Tabs the operator took out of their group: left alone from then on. */
  optedOut: number[];
}

export const titleOf = (name: string): string => `bushwhack · ${name}`;

/** A colour per project, the same every time. */
export function colorOf(name: string): (typeof COLORS)[number] {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

/** Whether to put a tab in the session's group. */
export function shouldJoin(tab: { id: number; groupId: number }, ours: number | undefined, state: GroupState): boolean {
  if (state.optedOut.includes(tab.id)) return false;
  if (ours !== undefined && tab.groupId === ours) return false;
  // In no group, or in the one this module put it in (another project's, the chat it
  // showed before): it may move. In any other group, it is the operator's doing.
  return tab.groupId === NO_GROUP || state.placed[tab.id] === tab.groupId;
}

/** Whether to take a tab out of its group: only from the group this module put it in. */
export function shouldLeave(tab: { id: number; groupId: number }, state: GroupState): boolean {
  return tab.groupId !== NO_GROUP && state.placed[tab.id] === tab.groupId && !state.optedOut.includes(tab.id);
}

/**
 * The project whose app a URL shows: octopod serves a project's app at
 * `<project>.localhost` (any port, subdomains for more routes). A tab opened on it by hand
 * joins the project's group like one page:open opened.
 */
export function appOwner<T extends { session: string }>(url: string, projects: T[]): T | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (!host.endsWith('.localhost')) return undefined;
  return projects.find((p) => host === `${p.session}.localhost` || host.endsWith(`.${p.session}.localhost`));
}

/** A tab left the group this module put it in, by someone else's hand: opt it out. */
export function afterMove(state: GroupState, tabId: number, groupId: number): GroupState {
  const placed = state.placed[tabId];
  if (placed === undefined || placed === groupId) return state;
  const { [tabId]: _, ...rest } = state.placed;
  return { ...state, placed: rest, optedOut: [...state.optedOut, tabId] };
}

async function load(): Promise<GroupState> {
  const raw = (await chrome.storage.session.get(KEY))[KEY] as Partial<GroupState> | undefined;
  return { groups: raw?.groups ?? {}, placed: raw?.placed ?? {}, optedOut: raw?.optedOut ?? [] };
}

async function save(state: GroupState): Promise<void> {
  await chrome.storage.session.set({ [KEY]: state });
}

/** Tabs being grouped right now: their own onUpdated events are not the operator's doing. */
const moving = new Set<number>();

async function existing(state: GroupState, session: string, name: string, windowId: number): Promise<number | undefined> {
  const known = state.groups[`${session}@${windowId}`];
  if (known !== undefined) {
    const group = await chrome.tabGroups.get(known).catch(() => undefined);
    if (group && group.windowId === windowId) return group.id;
  }
  const [byTitle] = await chrome.tabGroups.query({ windowId, title: titleOf(name) });
  return byTitle?.id;
}

/** Put a tab in its session's group in that window, creating the group if needed. */
export async function joinSessionGroup(tabId: number, session: string, name: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.id === undefined) return;
  let state = await load();
  const ours = await existing(state, session, name, tab.windowId);
  if (!shouldJoin({ id: tab.id, groupId: tab.groupId }, ours, state)) return;
  moving.add(tabId);
  try {
    const groupId =
      ours !== undefined
        ? await chrome.tabs.group({ groupId: ours, tabIds: [tabId] })
        : await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: titleOf(name), color: colorOf(name), collapsed: false });
    state = await load();
    await save({ ...state, groups: { ...state.groups, [`${session}@${tab.windowId}`]: groupId }, placed: { ...state.placed, [tabId]: groupId } });
  } finally {
    moving.delete(tabId);
  }
}

/** Take a tab out of the group this module put it in: it no longer shows a bound chat. */
export async function leaveSessionGroup(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.id === undefined) return;
  const state = await load();
  if (!shouldLeave({ id: tab.id, groupId: tab.groupId }, state)) return;
  moving.add(tabId);
  try {
    await chrome.tabs.ungroup(tabId);
    const { [tabId]: _, ...rest } = (await load()).placed;
    await save({ ...(await load()), placed: rest });
  } finally {
    moving.delete(tabId);
  }
}

/** The window where the session already has a group: where its app tab belongs. */
export async function sessionWindow(session: string): Promise<number | undefined> {
  const state = await load();
  for (const [key, groupId] of Object.entries(state.groups)) {
    if (!key.startsWith(`${session}@`)) continue;
    const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
    if (group) return group.windowId;
  }
  return undefined;
}

export function watchTabGroups(): void {
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.groupId === undefined || moving.has(tabId)) return;
    void load().then((state) => {
      const next = afterMove(state, tabId, change.groupId!);
      if (next !== state) return save(next);
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void load().then(({ groups, placed, optedOut }) => {
      const { [tabId]: _, ...rest } = placed;
      return save({ groups, placed: rest, optedOut: optedOut.filter((t) => t !== tabId) });
    });
  });
}
