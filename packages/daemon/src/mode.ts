/**
 * How this install gives a project its web app: through octopod — the normal way, the app
 * boxed in its containers — or standalone, where bushwhack serves the project's files as
 * they are and runs nothing. Standalone is chosen at setup (`setup.sh --standalone`,
 * `bushwhack mode standalone`), never taken as a fallback: without octopod, a normal
 * install has no app at all.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type AppMode = 'octopod' | 'standalone';
export const APP_MODES: readonly AppMode[] = ['octopod', 'standalone'];

/**
 * Where the mode is written. An `env` given for the state (a test's, or an instance's) that
 * says nothing of the configuration leaves it where this process's environment puts it.
 */
export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bushwhack', 'config.json');
}

/** The mode written at setup; octopod when nothing was, or when the file cannot be read. */
export async function readMode(env: NodeJS.ProcessEnv = process.env): Promise<AppMode> {
  try {
    const { mode } = JSON.parse(await readFile(configFile(env), 'utf8')) as { mode?: unknown };
    return mode === 'standalone' ? 'standalone' : 'octopod';
  } catch {
    return 'octopod';
  }
}

export async function writeMode(mode: AppMode, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = configFile(env);
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // none yet
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...config, mode }, null, 2) + '\n');
}
