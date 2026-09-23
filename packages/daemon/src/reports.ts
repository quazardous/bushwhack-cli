/**
 * report:bug — the model reports a problem with bushwhack itself: a tool that misbehaves,
 * a result that contradicts the files, a tool it needs that is missing. The model is the
 * first to see those; written in its answer, they would be lost.
 *
 * A report is kept in the project's `.bushwhack/reports.jsonl` (out of the model's sight,
 * like the rest of `.bushwhack/`) with what makes it stand alone: the conversation, the
 * version, and the calls it names with their results as recorded — already masked. The
 * operator sees its title at once in their terminal; `bushwhack reports` lists them.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Result, ToolSpec } from '@bushwhack/protocol';
import type { ToolOutcome, ToolRun } from './dispatcher.js';
import type { CallStore } from './store.js';

/** Reports one conversation may file: a model stuck in a loop fills no disk. */
export const MAX_REPORTS_PER_CONVERSATION = 20;
const MAX_CITED = 10;
const MAX_RESULT_CHARS = 2000;

export const REPORT_TOOLS: ToolSpec[] = [
  {
    name: 'report:bug',
    summary:
      'Tell bushwhack’s developers — this bridge and its tools; they get it through me — of a bug (a tool that misbehaves, a result that contradicts the files, an error that looks like the bridge’s) or a suggestion (something unclear in this manifest or a tool’s description, a tool you missed, something that cost you time). I see its title at once.',
    approval: false,
    params: {
      kind: { type: 'enum', description: 'a bug, or a suggestion', values: ['bug', 'suggestion'], default: 'bug' },
      title: { type: 'text', description: 'the problem or the idea, in one line', required: true, maxLength: 120 },
      calls: { type: 'text', description: 'the ids of the calls concerned, comma-separated', maxLength: 200 },
    },
    body: { description: 'a bug: what happened, and what you expected instead; a suggestion: what got in your way, and what would have helped', required: true, maxBytes: 8000 },
    notes: [
      'For a bug, write what they need to see it again: the tool and the arguments you gave, the exact text of the result or the error, and what you expected. Name the calls concerned in `calls`: their results are joined to the report.',
      'A suggestion is as welcome: whenever the tools or their descriptions slowed you down or left you guessing, say so, as it happens.',
      'Not for: a `denied` call (that was me saying no); a mistake in your own call (an `fs:edit` whose SEARCH does not match: re-read the file, try again); a bug of the project or of its app.',
      'One report per point. Do not wait for an answer and do not file it again: carry on with the work.',
    ],
    example: {
      args: { title: 'fs:read stopped at line 180 but said lines 1-200', calls: 'c7' },
      body: 'I called fs:read with path src/app.ts and no range. The result said `lines: 1-200 of 350`,\nbut its content ended at line 180, in the middle of a function.\nExpected: the 200 lines it announced.',
    },
  },
];

export interface Report {
  at: string;
  /** Absent in reports filed before suggestions existed: a bug. */
  kind?: 'bug' | 'suggestion';
  conversation: string;
  /** The report:bug call's own id. */
  id: string;
  title: string;
  text: string;
  version: string;
  calls: { id: string; result?: Result }[];
}

const fileOf = (stateDir: string): string => join(stateDir, 'reports.jsonl');

export async function readReports(stateDir: string): Promise<Report[]> {
  const text = await readFile(fileOf(stateDir), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Report];
      } catch {
        return [];
      }
    });
}

export interface ReportContext {
  stateDir: string;
  store: CallStore;
  version: string;
  /** Masks the project's secret values: a report is as masked as anything the chat gets. */
  mask: (text: string) => string;
  /** Tell the operator, now. */
  notice: (text: string) => void;
}

export async function runReportTool(ctx: ReportContext, call: ToolRun & { id: string; conversation: string }): Promise<ToolOutcome> {
  const filed = (await readReports(ctx.stateDir)).filter((r) => r.conversation === call.conversation).length;
  if (filed >= MAX_REPORTS_PER_CONVERSATION) {
    return { status: 'error', content: `this conversation already filed ${filed} reports, the most it may — tell me in your answer instead` };
  }
  const ids = String(call.args.calls ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, MAX_CITED);
  const report: Report = {
    at: new Date().toISOString(),
    conversation: call.conversation,
    id: call.id,
    kind: call.args.kind === 'suggestion' ? 'suggestion' : 'bug',
    title: ctx.mask(String(call.args.title)),
    text: ctx.mask(call.body ?? ''),
    version: ctx.version,
    calls: ids.map((id) => {
      const result = ctx.store.resultOf(call.conversation, id);
      return result ? { id, result: { ...result, ...(result.content ? { content: result.content.slice(0, MAX_RESULT_CHARS) } : {}) } } : { id };
    }),
  };
  await appendFile(fileOf(ctx.stateDir), JSON.stringify(report) + '\n', { mode: 0o600 });
  ctx.notice(`${report.kind === 'suggestion' ? '💡' : '🐞'} ${report.title}`);
  return { status: 'ok', content: 'reported; carry on with the work' };
}

// ─── What became of each report ─────────────────────────────────────────────────

/**
 * `new` until someone deals with it: `taken` (it is being worked on — the note says
 * where) or `dismissed` (not a bushwhack bug, or a duplicate). Kept beside the reports,
 * never in them: the reports file is only ever appended to.
 */
export type ReportState = 'new' | 'taken' | 'dismissed';

export interface ReportMark {
  state: Exclude<ReportState, 'new'>;
  note?: string;
  at: string;
}

const marksOf = (stateDir: string): string => join(stateDir, 'reports-state.json');
/** A report's name: its call id is unique in its conversation. */
export const reportKey = (r: Pick<Report, 'conversation' | 'id'>): string => `${r.conversation}#${r.id}`;

export async function readMarks(stateDir: string): Promise<Record<string, ReportMark>> {
  try {
    return JSON.parse(await readFile(marksOf(stateDir), 'utf8')) as Record<string, ReportMark>;
  } catch {
    return {};
  }
}

export async function markReport(stateDir: string, report: Report, state: ReportMark['state'], note?: string): Promise<void> {
  const marks = await readMarks(stateDir);
  marks[reportKey(report)] = { state, ...(note ? { note } : {}), at: new Date().toISOString() };
  await writeFile(marksOf(stateDir), JSON.stringify(marks, null, 2) + '\n', { mode: 0o600 });
}

/** A report as listed: which project, its number there, and what became of it. */
export interface ListedReport extends Report {
  project: string;
  folder: string;
  /** 1-based, in its project's file: `bushwhack reports <n>` there, `<project>:<n>` anywhere. */
  n: number;
  state: ReportState;
  note?: string;
}

/** The reports of these projects, oldest first within each. A missing folder has none. */
export async function listReports(projects: { name: string; folder: string }[]): Promise<ListedReport[]> {
  const out: ListedReport[] = [];
  for (const { name, folder } of projects) {
    const stateDir = join(folder, '.bushwhack');
    const marks = await readMarks(stateDir);
    (await readReports(stateDir)).forEach((r, i) => {
      const mark = marks[reportKey(r)];
      out.push({ ...r, project: name, folder, n: i + 1, state: mark?.state ?? 'new', ...(mark?.note ? { note: mark.note } : {}) });
    });
  }
  return out;
}
