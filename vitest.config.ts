import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve each other from source (`bushwhack-src` in their exports):
// nothing needs a build step to be tested, run by tsx, or bundled into the extension.
// Never the machine's own configuration — a test that wants another mode writes it. The
// tests run in octopod mode, the one with the app tools: standalone is the default now.
const config = join(tmpdir(), 'bushwhack-tests-config');
mkdirSync(join(config, 'bushwhack'), { recursive: true });
writeFileSync(join(config, 'bushwhack', 'config.json'), '{"mode":"octopod"}\n');

export default defineConfig({
  resolve: { conditions: ['bushwhack-src'] },
  ssr: { resolve: { conditions: ['bushwhack-src'] } },
  test: {
    env: { XDG_CONFIG_HOME: config },
  },
});
