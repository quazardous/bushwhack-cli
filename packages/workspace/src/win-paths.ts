/**
 * The names Windows reads as another name, or as no file at all — each a way around the
 * workspace's jail on NTFS, where a check that compares names as written would be fooled:
 *
 * - `a:b` is stream `b` of file `a` (`.env::$DATA` is `.env`'s content);
 * - a trailing dot or space is dropped (`.git.` is `.git`, `.env ` is `.env`);
 * - `CON`, `NUL`, `COM1`… are devices, with any extension (`nul.txt`);
 * - `BUSHWH~1` may be the short 8.3 name of `.bushwhack`.
 *
 * Pure: the rules are tested on any system; the workspace applies them on Windows.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const SHORT_NAME = /~\d/;

/** Why a path's segment is refused on Windows, or `undefined` when it is a plain name. */
export function windowsNameProblem(segment: string): string | undefined {
  if (segment === '' || segment === '.' || segment === '..') return undefined;
  if (segment.includes(':')) return 'a ":" names an NTFS stream';
  if (/[. ]$/.test(segment)) return 'Windows drops a trailing dot or space';
  if (RESERVED.test(segment)) return 'a reserved device name';
  if (SHORT_NAME.test(segment)) return 'it may be a short 8.3 name of another file';
  return undefined;
}

/** A name as Windows (and a case-insensitive file system) compares it: lower case, no trailing dots or spaces. */
export function comparableName(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}
