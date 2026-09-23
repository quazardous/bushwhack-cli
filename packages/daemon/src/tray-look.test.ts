/**
 * The Windows tray's wording (bin/bushwhack-tray-look.ps1): free of WinForms, so it runs
 * here under pwsh — skipped where pwsh is not installed. And the tray's files stay ASCII,
 * for Windows PowerShell 5.1.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'bin');
const LOOK = join(BIN, 'bushwhack-tray-look.ps1');
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

function pwsh(script: string): unknown {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', `. '${LOOK}'; ${script} | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

const list = JSON.stringify({
  mode: 'standalone',
  code: 'ABCD-EFGH',
  browsers: [{ browser: 'Google Chrome 153', chats: ['shop'] }],
  projects: [
    { session: 'shop', folder: 'C:/p/shop', chat: { browser: 'Google Chrome 153', chat: 'Gemini' } },
    { session: 'blog', folder: 'C:/p/blog' },
  ],
}).replace(/'/g, "''");

describe('the Windows tray', () => {
  it('keeps its files ASCII, and dot-sources its wording', () => {
    for (const f of ['bushwhack-tray.ps1', 'bushwhack-tray-look.ps1']) expect(readFileSync(join(BIN, f), 'utf8'), f).not.toMatch(/[^\x00-\x7F]/);
    expect(readFileSync(join(BIN, 'bushwhack-tray.ps1'), 'utf8')).toContain(". (Join-Path $PSScriptRoot 'bushwhack-tray-look.ps1')");
  });

  it.skipIf(!hasPwsh)('says how many projects, how many chats live, and the mode', { timeout: 20_000 }, () => {
    expect(pwsh(`Get-TrayLook ('${list}' | ConvertFrom-Json)`)).toEqual({ up: true, line: '2 projects - 1 chat live (standalone)', tooltip: 'bushwhack - 2 projects, 1 chat live' });
    expect(pwsh(`Get-TrayLook $null`)).toMatchObject({ up: false, tooltip: 'bushwhack - service stopped' });
    expect(pwsh(`(Get-TrayLook ('{"projects":[],"browsers":[]}' | ConvertFrom-Json)).line`)).toBe('0 projects - no chat open, no browser paired');
  });

  it.skipIf(!hasPwsh)('names each project with the chat it is live in, and says when the service stops or comes back', { timeout: 20_000 }, () => {
    expect(pwsh(`('${list}' | ConvertFrom-Json).projects | ForEach-Object { Get-ProjectLabel $_ }`)).toEqual(['shop - live in Gemini', 'blog - no chat open']);
    expect(pwsh(`Get-TrayNews @{ up = $true } @{ up = $false }`)).toBe('The bushwhack service stopped');
    expect(pwsh(`Get-TrayNews @{ up = $false } @{ up = $true }`)).toBe('The bushwhack service is back');
    expect(pwsh(`$null -eq (Get-TrayNews $null @{ up = $true })`)).toBe(true);
  });
});
