// What the GNOME indicator shows for what bushwhack says, as pure functions — the same
// wording as the Windows tray's (bin/bushwhack-tray-look.ps1). No GNOME import here: the
// test runs these under Node.

/**
 * The summary for what `bushwhack list --json` printed, or `null` when the service does
 * not answer. `up` greys the icon when false.
 */
export function trayLook(list) {
  if (!list) return { up: false, line: 'The bushwhack service is not running' };
  const projects = (list.projects ?? []).filter(Boolean);
  const live = projects.filter((p) => p.chat);
  const browsers = (list.browsers ?? []).filter(Boolean);
  const count = projects.length === 1 ? '1 project' : `${projects.length} projects`;
  const chats = live.length === 0 ? 'no chat open' : live.length === 1 ? '1 chat live' : `${live.length} chats live`;
  const browser = browsers.length === 0 ? ', no browser paired' : '';
  const mode = list.mode === 'octopod' ? ' (octopod)' : '';
  return { up: true, line: `${count} — ${chats}${browser}${mode}` };
}

/** A project's menu entry: its name, and the chat it is live in. */
export function projectLabel(project) {
  if (project.chat) return `${project.session} — live in ${project.chat.chat || 'a web chat'}`;
  return `${project.session} — no chat open`;
}

/** What changed between two looks that is worth a notification; `null` when nothing. */
export function trayNews(before, after) {
  if (!before) return null;
  if (before.up && !after.up) return 'The bushwhack service stopped';
  if (!before.up && after.up) return 'The bushwhack service is back';
  return null;
}

/** The Mode submenu: both modes, the current one checked; octopod says when it is missing. */
export function modeChoices(current, octopodFound) {
  return [
    { mode: 'standalone', label: 'Standalone — the project\'s files, nothing run', checked: current === 'standalone', enabled: current !== 'standalone' },
    {
      mode: 'octopod',
      label: octopodFound ? 'octopod — the app in its containers' : 'octopod — not installed (npm i -g @quazardous/octopod)',
      checked: current === 'octopod',
      enabled: current !== 'octopod' && octopodFound,
    },
  ];
}
