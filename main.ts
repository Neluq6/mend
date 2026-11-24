// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

// ---------- lines, tiers (SPEC.md sections 3 and 5) ----------

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

interface Occ {
  tier: number;
  positions: number[];
}

function findOcc(lines: string[], o: string[], strict: boolean, from = 0, mustEndAt = -1): Occ | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (!lineEq(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok && (mustEndAt < 0 || i + o.length === mustEndAt)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface BodyLine {
  t: ' ' | '-' | '+';
  s: string;
}

/** The lines a replacement writes: context lines come from the file itself; at tier 2 the rest is re-indented. */
function buildN(matched: string[], oEntries: BodyLine[], nEntries: BodyLine[], tier: number): string[] {
  const ctxFile: string[] = [];
  oEntries.forEach((e, j) => {
    if (e.t === ' ') ctxFile.push(matched[j]!);
  });
  let ci = 0;
  const f = matched.length > 0 ? leadWs(matched[0]!) : '';
  const p = oEntries.length > 0 ? leadWs(oEntries[0]!.s) : '';
  return nEntries.map((e) => {
    if (e.t === ' ') return ctxFile[ci++]!;
    if (tier === 2 && e.s.trim() !== '' && e.s.startsWith(p)) return f + e.s.slice(p.length);
    return e.s;
  });
}

interface Ctx {
  strict: boolean;
  moves: [string, string][];
}

function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// ---------- unified diffs (SPEC.md section 6) ----------

interface UHunk {
  a: number;
  body: { t: ' ' | '-' | '+' | '\\'; s: string }[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerPath(raw: string): string {
  const tab = raw.indexOf('\t');
  return (tab >= 0 ? raw.slice(0, tab) : raw).trim();
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections: USection[] = [];
  let cur: (USection & { sawPair: boolean; inHeader: boolean }) | null = null;
  const fresh = (): USection & { sawPair: boolean; inHeader: boolean } => {
    const s = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [], sawPair: false, inHeader: true } as USection & { sawPair: boolean; inHeader: boolean };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && !cur.sawPair) {
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.sawPair = true;
      } else {
        cur = fresh();
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.sawPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: UHunk['body'] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') body.push({ t: ' ', s: '' });
        else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') body.push({ t: l[0] as UHunk['body'][number]['t'], s: l.slice(1) });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.t === ' ' && body[body.length - 1]!.s === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      cur.inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, ctx));
}

function noBreakAfter(body: UHunk['body'], kinds: (' ' | '+')[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (kinds.includes(body[k]!.t as ' ' | '+')) return body[k + 1]?.t === '\\';
  }
  return false;
}

function unifiedEdit(s: USection, ctx: Ctx): Edit {
  const oldRaw = s.pairOld ?? s.renameFrom ?? s.gitOld;
  const newRaw = s.pairNew ?? s.renameTo ?? s.gitNew;
  const creation = s.newFile || oldRaw === '/dev/null';
  const deletion = s.delFile || newRaw === '/dev/null';
  const oldP = oldRaw === null || oldRaw === '/dev/null' ? null : stripAB(oldRaw);
  const newP = newRaw === null || newRaw === '/dev/null' ? null : stripAB(newRaw);
  return (tree) => {
    if (creation) {
      const p = newP ?? oldP ?? '';
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastPlus: { body: UHunk['body']; idx: number } | null = null;
      for (const h of s.hunks) {
        h.body.forEach((b, idx) => {
          if (b.t === '+') {
            out.push(b.s);
            lastPlus = { body: h.body, idx };
          }
        });
      }
      const nb = lastPlus !== null && (lastPlus as { body: UHunk['body']; idx: number }).body[(lastPlus as { body: UHunk['body']; idx: number }).idx + 1]?.t === '\\';
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (nb ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = oldP ?? newP ?? '';
      needSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldP ?? '';
    const to = newP ?? from;
    needSafe(from);
    if (to !== from) needSafe(to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const model = splitFile(before);
    const lines = model.lines.slice();
    let fin = model.final;
    let d = 0;
    for (const h of s.hunks) {
      const oE: BodyLine[] = [];
      const nE: BodyLine[] = [];
      for (const b of h.body) {
        if (b.t === ' ' || b.t === '-') oE.push({ t: b.t, s: b.s });
        if (b.t === ' ' || b.t === '+') nE.push({ t: b.t, s: b.s });
      }
      const o = oE.map((e) => e.s);
      if (o.length > 0) {
        const occ = findOcc(lines, o, ctx.strict);
        if (occ === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let pos = occ.positions[0]!;
        for (const cand of occ.positions) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const matched = lines.slice(pos, pos + o.length);
        const runsToEnd = pos + o.length === lines.length;
        const seg = buildN(matched, oE, nE, occ.tier);
        lines.splice(pos, o.length, ...seg);
        if (runsToEnd) fin = !noBreakAfter(h.body, [' ', '+']);
        d += nE.length - oE.length;
      } else {
        const at = Math.min(h.a + d, lines.length);
        const atEnd = at === lines.length;
        lines.splice(at, 0, ...nE.map((e) => e.s));
        if (atEnd && nE.length > 0) fin = !noBreakAfter(h.body, ['+']);
        d += nE.length;
      }
    }
    const text = joinFile({ br: model.br, lines, final: fin });
    if (to !== from) {
      tree.now.set(from, null);
      tree.now.set(to, text);
      ctx.moves.push([from, to]);
    } else {
      tree.now.set(to, text);
    }
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function searchReplaceEdits(lines: string[], ctx: Ctx): Edit[] {
  interface Block {
    path: string;
    oldL: string[];
    newL: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let from = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= from; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let k = i + 1;
    const oldL: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
      oldL.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    k += 1;
    const newL: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      newL.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldL, newL });
    prevPath = path;
    from = k + 1;
    i = k + 1;
  }
  return blocks.map((b) => {
    const edit: Edit = (tree) => {
      needSafe(b.path);
      if (b.oldL.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const model = splitFile(before);
      const occ = findOcc(model.lines, b.oldL, ctx.strict);
      if (occ === null) throw new Fail('no-match', b.path);
      if (occ.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = occ.positions[0]!;
      const oE: BodyLine[] = b.oldL.map((s) => ({ t: '-' as const, s }));
      const nE: BodyLine[] = b.newL.map((s) => ({ t: '+' as const, s }));
      const seg = buildN(model.lines.slice(pos, pos + b.oldL.length), oE, nE, occ.tier);
      const out = model.lines.slice();
      out.splice(pos, b.oldL.length, ...seg);
      tree.now.set(b.path, joinFile({ br: model.br, lines: out, final: model.final }));
    };
    return edit;
  });
}

// ---------- V4A patches (SPEC.md section 8) ----------

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSec {
    kind: 'add' | 'del' | 'upd';
    path: string;
    startLine: number;
    body: { s: string; n: number }[];
  }
  const secs: RawSec[] = [];
  let i = first + 1;
  const secStart = (l: string): { kind: RawSec['kind']; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice(14).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'del', path: l.slice(17).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'upd', path: l.slice(17).trim() };
    return null;
  };
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const st = secStart(l);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: RawSec = { kind: st.kind, path: st.path, startLine: i + 1, body: [] };
    i += 1;
    while (i < last && secStart(lines[i]!) === null) {
      sec.body.push({ s: lines[i]!, n: i + 1 });
      i += 1;
    }
    while (sec.body.length > 0 && blank(sec.body[sec.body.length - 1]!.s)) sec.body.pop();
    secs.push(sec);
  }
  return secs.map((sec) => v4aEdit(sec, ctx));
}

function v4aEdit(sec: { kind: 'add' | 'del' | 'upd'; path: string; startLine: number; body: { s: string; n: number }[] }, ctx: Ctx): Edit {
  const p = sec.path;
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const b of sec.body) {
      if (b.s.startsWith('+')) fileLines.push(b.s.slice(1));
      else if (b.s === '') fileLines.push('');
      else throw new Exit2(`error: parse ${b.n}`);
    }
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'del') {
    for (const b of sec.body) {
      if (!blank(b.s)) throw new Exit2(`error: parse ${b.n}`);
    }
    return (tree) => {
      needSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  // update
  let moveTo: string | null = null;
  let body = sec.body;
  if (body.length > 0 && body[0]!.s.startsWith('*** Move to: ')) {
    moveTo = body[0]!.s.slice(13).trim();
    body = body.slice(1);
  }
  interface Chunk {
    anchor: string | null;
    eof: boolean;
    body: BodyLine[];
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const b of body) {
    const l = b.s;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, body: [] };
      chunks.push(cur);
    } else if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${b.n}`);
      cur.eof = true;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({ t: l === '' ? ' ' : (l[0] as BodyLine['t']), s: l === '' ? '' : l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${b.n}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.startLine}`);
  const to = moveTo;
  return (tree) => {
    needSafe(p);
    if (to !== null) needSafe(to);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const model = splitFile(before);
    const lines = model.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        const tiers = ctx.strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let idx = cursor; idx < lines.length; idx++) {
            if (lineEq(lines[idx]!, ch.anchor, tier)) {
              found = idx;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const oE = ch.body.filter((e) => e.t === ' ' || e.t === '-');
      const nE = ch.body.filter((e) => e.t === ' ' || e.t === '+');
      const o = oE.map((e) => e.s);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...nE.map((e) => e.s));
        cursor = at + nE.length;
      } else {
        const occ = findOcc(lines, o, ctx.strict, cursor, ch.eof ? lines.length : -1);
        if (occ === null) throw new Fail('no-match', p);
        const pos = occ.positions[0]!;
        const seg = buildN(lines.slice(pos, pos + o.length), oE, nE, occ.tier);
        lines.splice(pos, o.length, ...seg);
        cursor = pos + seg.length;
      }
    }
    const text = joinFile({ br: model.br, lines, final: model.final });
    if (to !== null) {
      tree.now.set(p, null);
      tree.now.set(to, text);
      ctx.moves.push([p, to]);
    } else {
      tree.now.set(p, text);
    }
  };
}

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, ctx) : kind === 'search-replace' ? searchReplaceEdits(lines, ctx) : v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const finalState = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  for (const [o, n] of ctx.moves) {
    if (tree.original(o) !== null && finalState(o) === null && tree.original(n) === null && finalState(n) !== null && byPath.has(o) && byPath.has(n)) {
      byPath.delete(o);
      byPath.set(n, `R ${o} -> ${n}`);
    }
  }
  const rows = [...byPath.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([, v]) => v);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
