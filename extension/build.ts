/**
 * Build the extension into extension/dist.
 *
 *   npm run ext:build          production build
 *   npm run ext:watch          development: rebuild on change, host the dev control
 *                              relay, and reload the extension after each build
 *
 * The manifest is generated: content-script matches and host permissions come from the
 * drivers, so adding a chat is one driver file, not a driver plus a manifest edit.
 *
 * Development builds connect to a control relay hosted here (see dev-control.ts): that
 * is how `npm run ext:dev` observes and drives the extension, and how it is reloaded —
 * Chromium refuses remote debugging on the default profile, and the dev profile is the
 * operator's own, because that is where the chat logins live.
 */
import { watch as fsWatch } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { DRIVERS } from '@bushwhack/chat-drivers';
import { EXTENSION_NODE_PREFIX, EXTENSION_RELOAD } from '@bushwhack/protocol';
import { RelayServer } from '@bushwhack/relay';
import { connectDev, devControl, type DevControl } from './dev-control.js';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Development builds go to their own folder: an unpacked extension's id is derived from
 * its path, so dev and production are two extensions — and a dev build never inherits a
 * service worker Chromium cached for a production build, which it keeps serving across
 * restarts whatever the files on disk say.
 */
const distFor = (dev: boolean): string => join(here, dev ? 'dist-dev' : 'dist');
let dist = distFor(false);
const root = join(here, '..');

async function version(): Promise<string> {
  return (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

/**
 * The manifest `key` pins the extension id, so it no longer depends on the folder the
 * extension is loaded from: dev and production each keep one id, across machines and
 * reloads. Only the public half lives in the repo (it is public by nature); the private
 * half is only needed to pack a .crx and stays outside the repo.
 */
async function publicKey(dev: boolean): Promise<string> {
  return (await readFile(join(here, 'keys', dev ? 'dev.pub' : 'prod.pub'), 'utf8')).trim();
}

function manifest(v: string, dev: boolean, key: string): unknown {
  const matches = DRIVERS.flatMap((d) => d.hosts.flatMap((h) => [`https://${h}/*`, `https://*.${h}/*`]));
  return {
    manifest_version: 3,
    name: dev ? 'bushwhack (dev)' : 'bushwhack',
    key,
    version: v,
    description: 'Lets a web chat work on a project folder on your machine, through a local bushwhack session.',
    // `alarms` only in development: the heartbeat that keeps the control channel up.
    // `scripting`: re-inject the content script into open chat tabs after an update.
    // `tabGroups`: the app tab of each session sits in a group named after it.
    permissions: dev ? ['storage', 'scripting', 'tabGroups', 'alarms'] : ['storage', 'scripting', 'tabGroups'],
    // `*.localhost`: the session apps, as the local edge serves them (page:* tools).
    // The CDNs a chat serves its generated pictures from: image:save reads them there.
    host_permissions: ['http://127.0.0.1/*', 'http://*.localhost/*', ...matches, ...DRIVERS.flatMap((d) => (d.imageHosts ?? []).map((h) => `https://*.${h}/*`))],
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: [
      { matches, js: ['content.js'], run_at: 'document_idle' },
      // The clipboard hook must be in the page's own world, and in place before the page's scripts.
      // BUSHWHACK_NO_PAGE_HOOK=1 leaves it out: to tell the hook's effects on a page from the page's own.
      ...(process.env.BUSHWHACK_NO_PAGE_HOOK ? [] : [{ matches, js: ['page-hook.js'], run_at: 'document_start', world: 'MAIN' }]),
    ],
    // No popup: the icon opens the panel over the chat (an overlay, see content.ts), or in a
    // tab of its own on any other page.
    action: { default_title: 'bushwhack' },
    // The panel as the overlay frames it: a copy of popup.html, web-accessible only on the
    // chat sites and at a per-session address — no site can frame it on its own to lure
    // clicks. popup.html itself stays a plain extension page: a dynamic-url resource is
    // blocked at its plain address, which a tab of its own needs.
    web_accessible_resources: [{ resources: ['frame.html'], matches, use_dynamic_url: true }],
  };
}

const buildOptions = (control: DevControl | undefined): esbuild.BuildOptions => ({
  outdir: dist,
  entryPoints: {
    background: join(here, 'src/background.ts'),
    content: join(here, 'src/content.ts'),
    'page-hook': join(here, 'src/page-hook.ts'),
    popup: join(here, 'src/popup.ts'),
    // Injected into the app tab only: the recorder by a registered content script, the
    // screenshot renderer on demand.
    'page-recorder': join(here, 'src/page-recorder.ts'),
    'page-shot': join(here, 'src/page-shot.ts'),
  },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  platform: 'browser',
  conditions: ['bushwhack-src'],
  sourcemap: control ? 'inline' : false,
  minify: !control,
  // Like any build-time config: the dev control relay's address and key are compiled into
  // the dev bundle, so the worker can connect the moment it starts.
  define: { __DEV__: String(Boolean(control)), __DEV_CONTROL__: JSON.stringify(control ?? null) },
  logLevel: 'warning',
});

let devBuild = 0;

/**
 * Dev builds carry a fourth version component that changes on every build. Chromium keeps
 * running a cached copy of the service worker while the version stays the same; a new
 * version is what makes it register the new script. (Clearing the cache instead would
 * mean deleting a directory of the operator's own profile, every site's workers with it.)
 */
async function manifestVersion(control: DevControl | undefined): Promise<string> {
  const base = await version();
  if (!control) return base;
  devBuild = devBuild === 0 ? Math.floor(Date.now() / 1000) % 60_000 : devBuild + 1;
  return `${base}.${devBuild % 65_535}`;
}

async function statics(control: DevControl | undefined): Promise<void> {
  await mkdir(dist, { recursive: true });
  const manifestJson = manifest(await manifestVersion(control), Boolean(control), await publicKey(Boolean(control)));
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifestJson, null, 2) + '\n');
  await copyFile(join(here, 'src/popup.html'), join(dist, 'popup.html'));
  await copyFile(join(here, 'src/popup.html'), join(dist, 'frame.html'));
}

/** Ask the extension, over the dev control relay, to reload itself. */
async function reload(control: DevControl): Promise<void> {
  const client = await connectDev(control, 'build');
  try {
    client.node.emit(EXTENSION_RELOAD, {}, { target: `${EXTENSION_NODE_PREFIX}*` });
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const watch = process.argv.includes('--watch');
  const control = watch ? await devControl() : undefined;
  dist = distFor(watch);
  await rm(dist, { recursive: true, force: true });
  await statics(control);
  if (!watch || !control) {
    await esbuild.build(buildOptions(undefined));
    console.log(`built ${dist}`);
    return;
  }

  const relay = new RelayServer({
    port: control.port,
    logDir: join(dist, '..', '.dev-logs'),
    securityKey: control.key,
    version: 'dev',
    quiet: true,
    health: { service: 'bushwhack-dev' },
  });
  await relay.listen();

  const ctx = await esbuild.context({
    ...buildOptions(control),
    plugins: [
      {
        name: 'reload',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length > 0) return;
            await statics(control);
            await reload(control).catch(() => undefined);
            console.log(`${new Date().toLocaleTimeString()} built, reload sent`);
          });
        },
      },
    ],
  });
  await ctx.watch();
  // esbuild watches the scripts only: the panel's HTML, copied as it is, would otherwise
  // reach the build at the next script change. (A change to this file — the manifest — needs
  // the watcher restarted.)
  let pending: ReturnType<typeof setTimeout> | undefined;
  fsWatch(join(here, 'src/popup.html'), () => {
    clearTimeout(pending);
    pending = setTimeout(() => void ctx.rebuild().catch(() => undefined), 150);
  });
  console.log(`watching; built into ${dist}; dev control relay on ws://127.0.0.1:${control.port}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
