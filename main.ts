// main.ts is mend, the CLI SPEC.md specifies (MIT). It applies the edits AI models write, in four formats, to a
// tree of text files: unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and
// JSON edits (section 9), with line matching at three tiers (section 5) and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------
// A file's lines (SPEC.md section 3): its own line break, its lines, whether
// it ends with a line break. An empty file has no lines and no final break.
// ---------------------------------------------------------------------------

interface Lines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitText(text: string): Lines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinText(l: Lines): string {
  if (l.lines.length === 0) return '';
  return l.lines.join(l.br) + (l.final ? l.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; with --strict only 0) at which O occurs at or after `from`. */
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, o, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** Tier-2 re-indent: a non-blank line of N starting with P has that P replaced by F. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

// A hunk or chunk body: context lines, deletions and additions, in body order.
type BodyItem = { kind: 'ctx' | 'del' | 'add'; text: string };

/**
 * The lines a hunk or chunk writes when it replaces O at `pos` in `file` at `tier`: a context line is written
 * as the file's own matched line, and at tier 2 every other line is re-indented (section 5).
 */
function replacement(items: BodyItem[], file: string[], pos: number, tier: number): string[] {
  const o: string[] = [];
  for (const it of items) if (it.kind !== 'add') o.push(it.text);
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = leadingWs(file[pos]!);
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(file[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(it.text, p, f) : it.text);
    }
  }
  return out;
}

/** The lines a SEARCH/REPLACE block writes: every new line is re-indented at tier 2. */
function srReplacement(n: string[], file: string[], pos: number, o: string[], tier: number): string[] {
  if (tier !== 2) return [...n];
  const p = leadingWs(o[0]!);
  const f = leadingWs(file[pos]!);
  return n.map((l) => reindent(l, p, f));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order, for the `R` output lines (section 2). */
  moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  a: number;
  items: BodyItem[];
  slashAfter: boolean[];
  fromEmpty: boolean[];
  noNlAfterLast: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: UnifiedHunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** A `--- `/`+++ ` path: the text after the four characters, up to the first tab, spaces removed. */
function dashPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: {
    gitOld: string | null;
    gitNew: string | null;
    dashOld: string | null;
    dashNew: string | null;
    renameOld: string | null;
    renameNew: string | null;
    create: boolean;
    remove: boolean;
    hunks: UnifiedHunk[];
  } | null = null;
  let state: 'out' | 'header' | 'body' | 'between' = 'out';
  let hunk: UnifiedHunk | null = null;

  const finishSection = (): void => {
    if (cur === null) return;
    const oldRaw = cur.dashOld ?? cur.renameOld ?? cur.gitOld;
    const newRaw = cur.dashNew ?? cur.renameNew ?? cur.gitNew;
    sections.push({
      oldPath: oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw,
      newPath: newRaw === null || newRaw === '/dev/null' ? null : newRaw,
      create: cur.create,
      remove: cur.remove,
      hunks: cur.hunks,
    });
    cur = null;
  };
  const finishHunk = (): void => {
    if (hunk === null || cur === null) return;
    while (hunk.items.length > 0 && hunk.fromEmpty[hunk.items.length - 1]) {
      hunk.items.pop();
      hunk.slashAfter.pop();
      hunk.fromEmpty.pop();
    }
    let flag = false;
    for (let k = hunk.items.length - 1; k >= 0; k -= 1) {
      if (hunk.items[k]!.kind !== 'del') {
        flag = hunk.slashAfter[k]!;
        break;
      }
    }
    hunk.noNlAfterLast = flag;
    cur.hunks.push(hunk);
    hunk = null;
  };
  const startGitSection = (i: number): number => {
    const m = DIFF_GIT.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    finishSection();
    cur = {
      gitOld: m[1]!,
      gitNew: m[2]!,
      dashOld: null,
      dashNew: null,
      renameOld: null,
      renameNew: null,
      create: false,
      remove: false,
      hunks: [],
    };
    state = 'header';
    return i + 1;
  };
  const startDashSection = (i: number): number => {
    finishSection();
    cur = {
      gitOld: null,
      gitNew: null,
      dashOld: stripPrefix(dashPath(lines[i]!)),
      dashNew: stripPrefix(dashPath(lines[i + 1]!)),
      renameOld: null,
      renameNew: null,
      create: false,
      remove: false,
      hunks: [],
    };
    state = 'header';
    return i + 2;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'body') {
      if (line.startsWith('diff --git')) {
        finishHunk();
        finishSection();
        state = 'out';
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
        finishSection();
        state = 'out';
        continue;
      }
      if (line.startsWith('@@')) {
        finishHunk();
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        hunk = { a: Number(m[1]), items: [], slashAfter: [], fromEmpty: [], noNlAfterLast: false };
        i += 1;
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        if (line.startsWith('\\')) {
          if (hunk!.items.length > 0) hunk!.slashAfter[hunk!.items.length - 1] = true;
        } else if (line === '') {
          hunk!.items.push({ kind: 'ctx', text: '' });
          hunk!.slashAfter.push(false);
          hunk!.fromEmpty.push(true);
        } else {
          const kind = line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'del' : 'add';
          hunk!.items.push({ kind, text: line.slice(1) });
          hunk!.slashAfter.push(false);
          hunk!.fromEmpty.push(false);
        }
        i += 1;
        continue;
      }
      finishHunk();
      state = 'between';
      continue;
    }
    if (state === 'out' || state === 'between') {
      if (line.startsWith('diff --git')) {
        i = startGitSection(i);
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        i = startDashSection(i);
        continue;
      }
      if (line.startsWith('@@')) {
        if (state === 'out') throw new Exit2(`error: parse ${i + 1}`);
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        hunk = { a: Number(m[1]), items: [], slashAfter: [], fromEmpty: [], noNlAfterLast: false };
        state = 'body';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    // state === 'header'
    if (line.startsWith('diff --git')) {
      i = startGitSection(i);
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur!.dashOld = stripPrefix(dashPath(line));
        cur!.dashNew = stripPrefix(dashPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('rename from ')) {
      cur!.renameOld = line.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur!.renameNew = line.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur!.create = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur!.remove = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), items: [], slashAfter: [], fromEmpty: [], noNlAfterLast: false };
      state = 'body';
      i += 1;
      continue;
    }
    i += 1;
  }
  finishHunk();
  finishSection();
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match', path) on a hunk failure. */
function applyHunks(before: string, hunks: UnifiedHunk[], path: string, strict: boolean): string {
  const cur = splitText(before);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    let nLen = 0;
    for (const it of h.items) {
      if (it.kind !== 'add') o.push(it.text);
      if (it.kind !== 'del') nLen += 1;
    }
    if (o.length === 0) {
      const ins: string[] = [];
      for (const it of h.items) if (it.kind === 'add') ins.push(it.text);
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const atEnd = at === cur.lines.length;
      cur.lines.splice(at, 0, ...ins);
      if (atEnd) cur.final = !h.noNlAfterLast;
    } else {
      const found = findTier(cur.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      for (const pos of found.at) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const rep = replacement(h.items, cur.lines, best, found.tier);
      const runsToEnd = best + o.length === cur.lines.length;
      cur.lines.splice(best, o.length, ...rep);
      if (runsToEnd) cur.final = !h.noNlAfterLast;
    }
    d += nLen - o.length;
  }
  return joinText(cur);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree: Tree): void => {
    if (s.create || s.oldPath === null) {
      const p = s.newPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastAddSlash = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.items.length; k += 1) {
          if (h.items[k]!.kind === 'add') {
            plus.push(h.items[k]!.text);
            lastAddSlash = h.slashAfter[k]!;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastAddSlash ? '' : '\n'));
      return;
    }
    if (s.remove || s.newPath === null) {
      const p = s.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = s.oldPath!;
    const newP = s.newPath!;
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(before, s.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, s.hunks, oldP, strict));
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const cur = splitText(before);
    const found = findTier(cur.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.at[0]!;
    const rep = srReplacement(b.newLines, cur.lines, pos, b.oldLines, found.tier);
    cur.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinText(cur));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const path = line.slice(prefix.length).trim();
    const updateLine = i + 1;
    i += 1;
    const raw: string[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${updateLine + 1 + k}`);
      }
      sections.push({ kind, path, moveTo: null, lines: fileLines, chunks: [], updateLine });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${updateLine + 1 + k}`);
      }
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], updateLine });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      const finishChunk = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      for (; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          finishChunk();
          const anchorText = l.slice(2).trim();
          chunk = { anchor: anchorText === '' ? null : anchorText, items: [], eof: false };
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${updateLine + 1 + k}`);
          chunk.eof = true;
          finishChunk();
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${updateLine + 1 + k}`);
            chunk = { anchor: null, items: [], eof: false };
          }
          const itemKind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add';
          chunk.items.push({ kind: itemKind, text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${updateLine + 1 + k}`);
      }
      finishChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, updateLine });
    }
  }
  return sections.map((s) => (tree: Tree): void => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const cur = splitText(before);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const anchorFound = findTier(cur.lines, [c.anchor], cursor, strict);
        if (anchorFound === null) throw new Fail('no-match', s.path);
        cursor = anchorFound.at[0]! + 1;
      }
      const o: string[] = [];
      for (const it of c.items) if (it.kind !== 'add') o.push(it.text);
      if (o.length === 0) {
        const ins: string[] = [];
        for (const it of c.items) if (it.kind === 'add') ins.push(it.text);
        const at = c.eof ? cur.lines.length : cursor;
        cur.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(cur.lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', s.path);
      let pos: number | null = null;
      if (c.eof) {
        for (const p of found.at) {
          if (p + o.length === cur.lines.length) {
            pos = p;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', s.path);
      } else {
        pos = found.at[0]!;
      }
      const rep = replacement(c.items, cur.lines, pos, found.tier);
      cur.lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = joinText(cur);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push({ old: s.path, nw: s.moveTo });
    } else {
      tree.now.set(s.path, out);
    }
  });
}

// ---------------------------------------------------------------------------
// The command line, output and exit codes (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.nw);
    const newNow = tree.get(m.nw);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      consumed.add(m.old);
      consumed.add(m.nw);
    }
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
