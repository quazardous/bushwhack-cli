/**
 * The boundary of the page:* tools: the session app's origins, given by the daemon (from
 * octopod's routes). The operator's browser is logged into everything; a page tool that
 * could act on another origin would turn "look at your app" into "read my mail".
 */

/** `http://demo.localhost:8480/x?y` → `http://demo.localhost:8480`; undefined when not a URL. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function allowed(url: string | undefined, origins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== undefined && origins.includes(origin);
}

/**
 * The URL for a path the model gave, on the app's first origin. The model names a path,
 * never an origin: `//evil.example/x` or `http://…` in a path is refused.
 */
export function urlFor(origin: string, path: string): string {
  const clean = path.trim() === '' ? '/' : path.trim();
  if (!clean.startsWith('/') || clean.startsWith('//') || /^\/\\|[\r\n]/.test(clean)) {
    throw new Error(`"${path}" is not a path on the app (start with a single /)`);
  }
  const url = new URL(clean, origin);
  if (url.origin !== origin) throw new Error(`"${path}" leaves the app`);
  return url.href;
}
