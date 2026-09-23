import { defineConfig } from 'vitest/config';

// Workspace packages resolve each other from source (`bushwhack-src` in their exports):
// nothing needs a build step to be tested, run by tsx, or bundled into the extension.
export default defineConfig({
  resolve: { conditions: ['bushwhack-src'] },
  ssr: { resolve: { conditions: ['bushwhack-src'] } },
});
