// bushwhack in GNOME Shell's top bar — the counterpart of the Windows tray (bin/bushwhack-tray.ps1).
//
// A view, not a supervisor: every few seconds it asks the service's /health (its port read
// from service.json), and only when the service answers does it run `bushwhack list --json`,
// in the background — the panel never waits on the service, and looking never starts it.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { modeChoices, projectLabel, trayLook, trayNews } from './look.js';

const REFRESH_SECONDS = 5;
const GITHUB = 'https://github.com/quazardous/bushwhack-cli';

/** The `bushwhack` command: on the PATH, or where setup.sh links it. */
function bushwhackPath() {
  return GLib.find_program_in_path('bushwhack') ?? GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'bushwhack']);
}

/** The default instance's service file: its port, its pairing code. */
function serviceFile() {
  const state = GLib.getenv('XDG_STATE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
  try {
    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([state, 'bushwhack', 'service', 'service.json']));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Run a command, its stdout as text; never throws — `null` on failure. */
function run(argv) {
  return new Promise((resolve) => {
    try {
      const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
      proc.communicate_utf8_async(null, null, (p, res) => {
        try {
          const [, out] = p.communicate_utf8_finish(res);
          resolve(p.get_successful() ? out : null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/** Start a program and let it go (a terminal, a mode change). */
function spawn(argv, cwd) {
  try {
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
    if (cwd) launcher.set_cwd(cwd);
    launcher.spawnv(argv);
    return true;
  } catch (e) {
    Main.notifyError('bushwhack', `Could not start ${argv[0]}: ${e.message}`);
    return false;
  }
}

/** A terminal running `command` in `folder`: the first of GNOME's terminals found. */
function openTerminal(folder, command) {
  const terminals = [
    ['ptyxis', ['--new-window', '--working-directory', folder, '--', ...command]],
    ['kgx', [`--working-directory=${folder}`, '--', ...command]],
    ['gnome-terminal', [`--working-directory=${folder}`, '--', ...command]],
    ['xdg-terminal-exec', command],
  ];
  for (const [name, args] of terminals) {
    const path = GLib.find_program_in_path(name);
    if (path) return spawn([path, ...args], folder);
  }
  Main.notifyError('bushwhack', 'No terminal found (ptyxis, kgx, gnome-terminal or xdg-terminal-exec)');
  return false;
}

function openUri(uri) {
  try {
    Gio.AppInfo.launch_default_for_uri(uri, null);
  } catch (e) {
    Main.notifyError('bushwhack', `Could not open ${uri}: ${e.message}`);
  }
}

const ConfirmDialog = GObject.registerClass(
  class ConfirmDialog extends ModalDialog.ModalDialog {
    _init(title, body, action, onConfirm) {
      super._init({ styleClass: 'modal-dialog' });
      const box = new St.BoxLayout({ vertical: true, style: 'spacing: 12px; padding: 12px;' });
      box.add_child(new St.Label({ text: title, style: 'font-weight: bold; font-size: 1.1em;' }));
      box.add_child(new St.Label({ text: body }));
      this.contentLayout.add_child(box);
      this.setButtons([
        { label: 'Cancel', action: () => this.close(), key: 0xff1b /* Escape */ },
        { label: action, action: () => (this.close(), onConfirm()), default: true },
      ]);
    }
  },
);

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(dir) {
      super._init(0.5, 'bushwhack');
      this._icons = {
        up: Gio.FileIcon.new(dir.get_child('icons').get_child('bushwhack.svg')),
        down: Gio.FileIcon.new(dir.get_child('icons').get_child('bushwhack-down.svg')),
      };
      this._icon = new St.Icon({ gicon: this._icons.down, style_class: 'system-status-icon' });
      this.add_child(this._icon);
      this._session = new Soup.Session({ timeout: 2 });
      this._look = null;
      this._list = null;
      this._busy = false;
      this.menu.connect('open-state-changed', (_menu, open) => {
        if (open) this._refresh();
      });
      this._render();
      this._refresh();
      this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      });
    }

    /** /health, then `bushwhack list --json` when the service answers. */
    async _refresh() {
      if (this._busy) return;
      this._busy = true;
      try {
        const file = serviceFile();
        const up = file?.port ? await this._health(file.port) : false;
        const out = up ? await run([bushwhackPath(), 'list', '--json']) : null;
        let list = null;
        try {
          list = out ? JSON.parse(out) : null;
        } catch {
          list = null;
        }
        const look = trayLook(list);
        const news = trayNews(this._look, look);
        if (news) Main.notify('bushwhack', news);
        const changed = JSON.stringify(list) !== JSON.stringify(this._list) || look.up !== this._look?.up;
        this._look = look;
        this._list = list;
        if (changed && !this._destroyed) this._render();
      } finally {
        this._busy = false;
      }
    }

    _health(port) {
      return new Promise((resolve) => {
        const message = Soup.Message.new('GET', `http://127.0.0.1:${port}/health`);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
          try {
            const bytes = session.send_and_read_finish(res);
            const health = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            resolve(message.get_status() === 200 && health?.service === 'bushwhack');
          } catch {
            resolve(false);
          }
        });
      });
    }

    _render() {
      const look = this._look ?? trayLook(null);
      const list = this._list;
      this._icon.gicon = look.up ? this._icons.up : this._icons.down;
      this.menu.removeAll();

      const summary = new PopupMenu.PopupMenuItem(look.line, { reactive: false });
      this.menu.addMenuItem(summary);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      if (!look.up) {
        this.menu.addAction('Start the service', () => {
          // `bushwhack list` starts it (systemd, or a background process), then answers.
          spawn([bushwhackPath(), 'list']);
          GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => (this._refresh(), GLib.SOURCE_REMOVE));
        });
      } else {
        for (const project of list.projects ?? []) {
          const sub = new PopupMenu.PopupSubMenuMenuItem(projectLabel(project));
          sub.menu.addAction('Open a terminal here', () => openTerminal(project.folder, [bushwhackPath()]));
          if (project.url) sub.menu.addAction('Open its app', () => openUri(project.url));
          sub.menu.addAction('Open the folder', () => openUri(Gio.File.new_for_path(project.folder).get_uri()));
          this.menu.addMenuItem(sub);
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (list.code) {
          this.menu.addAction(`Copy the pairing code (${list.code})`, () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, list.code);
            Main.notify('bushwhack', 'Pairing code copied — paste it in the bushwhack panel, never in a chat');
          });
        }
        this.menu.addAction('Open an approvals terminal', () => openTerminal(GLib.get_home_dir(), [bushwhackPath(), 'approvals']));

        const mode = new PopupMenu.PopupSubMenuMenuItem('Mode');
        const octopodFound = GLib.find_program_in_path('octopod') !== null;
        for (const choice of modeChoices(list.mode, octopodFound)) {
          const item = new PopupMenu.PopupMenuItem(choice.label);
          item.setOrnament(choice.checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
          item.setSensitive(choice.enabled);
          item.connect('activate', () =>
            new ConfirmDialog(
              `Switch to ${choice.mode}?`,
              'The bushwhack service restarts in that mode: every project\'s chat reconnects, and a call running now is lost.',
              'Switch',
              () => spawn([bushwhackPath(), 'mode', choice.mode]),
            ).open(),
          );
          mode.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(mode);
      }

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addAction('bushwhack on GitHub', () => openUri(GITHUB));
    }

    destroy() {
      this._destroyed = true;
      if (this._timer) GLib.source_remove(this._timer);
      this._timer = 0;
      this._session?.abort();
      super.destroy();
    }
  },
);

export default class BushwhackExtension extends Extension {
  enable() {
    this._indicator = new Indicator(this.dir);
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
