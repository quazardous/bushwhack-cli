/**
 * The examples in the manifest are calls the model will copy: each must be one the
 * daemon accepts for its own tool — parsed, and typed against the tool's spec.
 */
import { describe, it, expect } from 'vitest';
import { bindArgs, exampleCall, renderManifest, scanCall, type ToolSpec } from '@bushwhack/protocol';
import { FS_TOOLS } from '@bushwhack/workspace';
import { PAGE_TOOLS } from '@bushwhack/page/daemon';
import { appTools } from './app.js';
import { IGNORE_TOOLS } from './ignores.js';
import { REPORT_TOOLS } from './reports.js';
import { SECRET_TOOLS } from './secrets.js';

const ALL: ToolSpec[] = [...FS_TOOLS, ...IGNORE_TOOLS, ...SECRET_TOOLS, ...REPORT_TOOLS, ...appTools(['node-app']), ...PAGE_TOOLS];

describe('tool examples', () => {
  it.each(ALL.filter((s) => s.example).map((s) => [s.name, s] as const))('%s: its example is a valid call of it', (_name, spec) => {
    const scanned = scanCall(exampleCall(spec)!);
    expect(scanned?.kind).toBe('call');
    if (scanned?.kind !== 'call') return;
    expect(scanned.call.tool).toBe(spec.name);
    expect(() => bindArgs(spec, scanned.call.args, scanned.call.body)).not.toThrow();
  });

  it('report:bug shows the model who reads it, that suggestions are welcome, what to put in, what it is not for, and an example', () => {
    const manifest = renderManifest(REPORT_TOOLS, { session: 'shop' });
    expect(manifest).toContain('Tell bushwhack’s developers');
    expect(manifest).toContain('or a suggestion (something unclear in this manifest');
    expect(manifest).toContain('the exact text of the result or the error');
    expect(manifest).toContain('Not for: a `denied` call');
    expect(manifest).toContain('do not file it again');
    expect(manifest).toContain('bushwhack: report:bug\nid: c9\ntitle: fs:read stopped at line 180');
  });
});
