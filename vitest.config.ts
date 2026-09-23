import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve each other from source (`bushwhack-src` in their exports):
// nothing needs a build step to be tested, run by tsx, or bundled into the extension.
export default defineConfig({
  resolve: { conditions: ['bushwhack-src'] },
  ssr: { resolve: { conditions: ['bushwhack-src'] } },
  test: {
    // Never the machine's own configuration: installed standalone, it would take the app
    // tools away from every test that expects them. A test that wants a mode writes it.
    env: { XDG_CONFIG_HOME: join(tmpdir(), 'bushwhack-tests-config-none') },
  },
});
