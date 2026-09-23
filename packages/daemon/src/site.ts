/**
 * Standalone mode's app: each project's files served as they are, at
 * `http://<project>.localhost:<port>/` — one server for every project of the process, told
 * apart by the Host header. Nothing of the project runs on the machine: its HTML, CSS and
 * JavaScript run in the browser's tab, as they would from any web server.
 *
 * What it serves is what fs:read reads (the workspace decides: .git/, .bushwhack/ and
 * ignored files do not exist), never a declared secret file. GET and HEAD only, no CORS
 * header, no cache: the page after an edit is the edited one.
 */
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { WorkspaceError, type Workspace } from '@bushwhack/workspace';

/** Right after the relays' range (47300–47319). */
export const SITE_PORTS = Array.from({ length: 10 }, (_, i) => 47320 + i);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function page(res: ServerResponse, status: number, text: string, head: boolean): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(head ? undefined : `${text}\n`);
}

export class ProjectSites {
  private readonly sites = new Map<string, Workspace>();
  private server?: Server;
  port = 0;

  /** The first free port of the range, with the server on it. */
  static async listen(ports: number[] = SITE_PORTS): Promise<ProjectSites> {
    const sites = new ProjectSites();
    for (const port of ports) {
      const server = createServer((req, res) => void sites.handle(req, res));
      const listening = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (listening) {
        sites.server = server;
        sites.port = (server.address() as { port: number }).port;
        return sites;
      }
    }
    throw new Error(`no free port for the projects' sites among ${ports[0]}–${ports[ports.length - 1]}`);
  }

  /** Where a project's site is: its own name under localhost, on this server's port. */
  urlOf(name: string): string {
    return `http://${name}.localhost:${this.port}/`;
  }

  add(name: string, workspace: Workspace): string {
    this.sites.set(name.toLowerCase(), workspace);
    return this.urlOf(name);
  }

  remove(name: string): void {
    this.sites.delete(name.toLowerCase());
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return page(res, 405, 'a site of files: GET only', false);
    // The Host decides the project, and only a project's own name answers: a page of
    // another origin, or a DNS name rebound to 127.0.0.1, gets nothing.
    const host = (req.headers.host ?? '').toLowerCase();
    const suffix = `.localhost:${this.port}`;
    const workspace = host.endsWith(suffix) ? this.sites.get(host.slice(0, -suffix.length)) : undefined;
    if (!workspace) return page(res, 404, 'no project here', head);

    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://site').pathname);
    } catch {
      return page(res, 400, 'a path that does not decode', head);
    }
    if (path.includes('\0')) return page(res, 400, 'a path with a NUL', head);
    const rel = path.replace(/^\/+/, '');
    try {
      let target = await workspace.served(rel.replace(/\/+$/, ''));
      if (target.isDir) {
        // A folder without its slash: relative links in its index.html would miss.
        if (!path.endsWith('/')) {
          res.writeHead(301, { location: `${path}/`, 'cache-control': 'no-store' });
          return void res.end();
        }
        try {
          target = await workspace.served(target.rel === '' ? 'index.html' : `${target.rel}/index.html`);
        } catch (e) {
          if (e instanceof WorkspaceError) return page(res, 404, `no index.html in /${rel}`, head);
          throw e;
        }
      }
      res.writeHead(200, {
        'content-type': TYPES[extname(target.abs).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      if (head) return void res.end();
      createReadStream(target.abs).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      // Hidden and missing answer alike: the page cannot probe which ignored files exist.
      if (e instanceof WorkspaceError) return page(res, 404, `/${rel}: not found`, head);
      return page(res, 500, 'the site failed on this request', head);
    }
  }
}
