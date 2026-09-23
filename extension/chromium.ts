/**
 * Start Chromium with the extension loaded.
 *
 *   npm run chromium [-- <url>]
 *
 * By default on the operator's own profile, where the chat logins live. For development
 * with a DevTools client (a DevTools MCP server, any CDP tool), two settings — from the
 * environment, or from a `.env.local` at the repository root (git-ignored):
 *
 *   BUSHWHACK_CHROMIUM_PROFILE=<dir>   a profile of its own (log into the chats there once)
 *   BUSHWHACK_DEBUG_PORT=<port>        the DevTools protocol, on 127.0.0.1 only
 *
 * The port needs its own profile: Chromium refuses remote debugging on the default one,
 * and rightly — whatever holds the port drives every session the profile is logged into.
 * Another profile is another browser: the operator's own Chromium can stay open.
 *
 * With BUSHWHACK_CHROMIUM_LOG=<file>, Chromium's log — including the extension's
 * `console.*` lines — goes to that file: the service worker has no other voice before it
 * reaches a relay.
 *
 * Chromium, not Chrome: branded Chrome stopped honouring `--load-extension`. And the
 * browser must not be running already — a second launch hands its URL to the running
 * process and drops every flag, silently.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** The development build when there is one (npm run ext:watch), the production build otherwise. */
const dist = existsSync(join(here, 'dist-dev', 'manifest.json')) ? join(here, 'dist-dev') : join(here, 'dist');
const CANDIDATES = ['chromium-browser', 'chromium'];

// Development settings, kept out of the code and out of git.
const localEnv = join(here, '..', '.env.local');
if (existsSync(localEnv)) process.loadEnvFile(localEnv);
/** undefined: the operator's own profile. */
const profile = process.env.BUSHWHACK_CHROMIUM_PROFILE || undefined;
const debugSetting = process.env.BUSHWHACK_DEBUG_PORT || undefined;
const debugPort = debugSetting === undefined ? undefined : Number(debugSetting);

function binary(): string | undefined {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return CANDIDATES.find((name) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0);
}

/**
 * A browser process on the same profile, not one of its helpers (those carry --type=).
 * Read from /proc by process name: matching command lines would also match any shell
 * whose command merely mentions the binary's path. Another profile is another browser,
 * and does not count.
 */
function running(): boolean {
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (!/^chromium/.test(comm)) continue;
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args.some((arg) => arg.startsWith('--type='))) continue;
      const dir = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      if (dir === profile) return true;
    } catch {
      // The process ended while we looked.
    }
  }
  return false;
}

/** Recent Chromium ignores `--load-extension` unless this feature is disabled. */
const LOAD_EXTENSION_GATE = 'DisableLoadExtensionCommandLineSwitch';
const DISTRO_CONF = '/etc/chromium/chromium.conf';

/**
 * Chromium keeps only the last `--disable-features`, so ours must be merged into any
 * list the distribution already passes, not appended after it. Fedora's wrapper builds
 * its flags from /etc/chromium/chromium.conf and lets CHROMIUM_USER_FLAGS replace them:
 * read them, merge, hand them back. Elsewhere, pass the flag as is.
 */
function launchFlags(): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!existsSync(DISTRO_CONF)) return { args: [`--disable-features=${LOAD_EXTENSION_GATE}`], env: process.env };
  const distro = (spawnSync('bash', ['-c', `. ${DISTRO_CONF} >/dev/null 2>&1; printf %s "$CHROMIUM_FLAGS"`], { encoding: 'utf8' }).stdout ?? '')
    .split(/\s+/)
    .filter(Boolean);
  let merged = false;
  const flags = distro.map((flag) => {
    if (!flag.startsWith('--disable-features=')) return flag;
    merged = true;
    return `${flag},${LOAD_EXTENSION_GATE}`;
  });
  if (!merged) flags.push(`--disable-features=${LOAD_EXTENSION_GATE}`);
  return { args: [], env: { ...process.env, CHROMIUM_USER_FLAGS: flags.join(' ') } };
}

function main(): void {
  if (!existsSync(join(dist, 'manifest.json'))) {
    console.error('no extension build: run `npm run ext:watch` (development) or `npm run ext:build` first.');
    process.exit(1);
  }
  const bin = binary();
  if (!bin) {
    console.error(`no Chromium found (tried ${CANDIDATES.join(', ')}); set CHROMIUM_BIN.`);
    process.exit(1);
  }
  if (running()) {
    console.error(
      profile
        ? `a Chromium is already running on ${profile}: quit it first, or the extension flag is ignored.`
        : 'Chromium is already running on your own profile: quit it first, or the extension flag is ignored.',
    );
    process.exit(1);
  }
  if (debugPort !== undefined && !(Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536)) {
    console.error(`BUSHWHACK_DEBUG_PORT must be a port, not ${debugSetting}`);
    process.exit(1);
  }
  if (debugPort !== undefined && !profile) {
    console.error('BUSHWHACK_DEBUG_PORT needs BUSHWHACK_CHROMIUM_PROFILE: Chromium refuses remote debugging on your own profile.');
    process.exit(1);
  }
  if (profile) mkdirSync(profile, { recursive: true, mode: 0o700 });
  const url = process.argv[2];
  const logFile = process.env.BUSHWHACK_CHROMIUM_LOG;
  const log = logFile ? openSync(logFile, 'a') : 'ignore';
  const { args, env } = launchFlags();
  const child = spawn(
    bin,
    [
      `--load-extension=${dist}`,
      // A fresh profile opens on Chromium's first-run screen, which holds the browser back —
      // the DevTools port included — until someone clicks through it.
      ...(profile ? [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'] : []),
      // Loopback only: the port drives the whole browser.
      ...(debugPort !== undefined ? [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`] : []),
      ...args,
      ...(logFile ? ['--enable-logging=stderr', '--v=0'] : []),
      ...(url ? [url] : []),
    ],
    { detached: true, stdio: ['ignore', log, log], env },
  );
  child.unref();
  console.log(`started ${bin} with ${dist}`);
  console.log(`  profile  ${profile ?? 'your own (default)'}`);
  if (debugPort !== undefined) console.log(`  devtools http://127.0.0.1:${debugPort}  (chrome-devtools-mcp --browserUrl http://127.0.0.1:${debugPort})`);
}

main();
