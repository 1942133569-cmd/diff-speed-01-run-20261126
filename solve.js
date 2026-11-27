// Fast drop-in for makefun-diff 1.0.0 (MIT).
//
// Returns exactly makefun-diff 1.0.0's patch for { old, new }: the same greedy
// Myers search (deletion wins ties, no edge pruning, snake after every step),
// the same common prefix/suffix trim, the same hunks and the same patch text.
// Only the machinery is faster:
//   - every line is interned to a small integer id once, so the search compares
//     ints in typed arrays instead of strings;
//   - the search keeps, per edit distance d, one Int32Array of the furthest old
//     position reached on each diagonal (the whole trace, so the exact path can
//     be walked back), instead of one linked-list path object per diagonal;
//     positions are stored as x + 1, so a fresh zero-filled array already
//     means "no path" and no fill pass is needed;
//   - the patch is built from the same runs the reference builds.
//
// Deterministic: no I/O, no clock, no cross-case state. Each run() call interns
// its own two texts and nothing is kept between cases.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** One line as the patch writes it: op, the line, a newline, "%" when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/**
 * The edit runs of the sliced id arrays, [{ kind, count }] in order.
 * a, b are Int32Array views of interned line ids. Mirrors the reference's
 * editRuns step for step: d = 0, 1, ...; k from -d to d in steps of 2; the
 * deletion candidate is the (d-1)-path on k-1 one old line further, the
 * insertion candidate the (d-1)-path on k+1 as it stands; the deletion wins
 * when both reach the same point; a move past either text's end is no
 * candidate; after the step the path follows equal lines as far as they go;
 * the first path to reach both ends is the script.
 */
function editRuns(a, b) {
  const N = a.length;
  const M = b.length;
  // trace[d] is the furthest old position (lines consumed) on each diagonal
  // k in [-d, d] after d edits and the snake, stored as x + 1; index k + d;
  // 0 means no path, which is what a fresh Int32Array already holds.
  const trace = [];
  let V = new Int32Array(1);
  let x = 0;
  let y = 0;
  while (x < N && y < M && a[x] === b[y]) { x++; y++; }
  V[0] = x + 1;
  trace.push(V);
  if (x >= N && y >= M) return backtrack(trace, 0, 0, N, M);
  for (let d = 1; d <= N + M; d++) {
    const prev = trace[d - 1];
    const prevLen = prev.length;
    const cur = new Int32Array(2 * d + 1);
    let foundK = 0;
    let found = false;
    for (let k = -d; k <= d; k += 2) {
      let xDel = -1;
      let xIns = -1;
      const iDel = k + d - 2;
      if (iDel >= 0 && iDel < prevLen) {
        const pv = prev[iDel];
        if (pv !== 0 && pv - 1 < N) xDel = pv;
      }
      const iIns = k + d;
      if (iIns >= 0 && iIns < prevLen) {
        const pv = prev[iIns];
        if (pv !== 0 && pv - 1 - (k + 1) < M) xIns = pv - 1;
      }
      if (xDel === -1 && xIns === -1) continue;
      let nx = xDel >= xIns ? xDel : xIns;
      let ny = nx - k;
      while (nx < N && ny < M && a[nx] === b[ny]) { nx++; ny++; }
      cur[k + d] = nx + 1;
      if (nx >= N && ny >= M) { foundK = k; found = true; break; }
    }
    trace.push(cur);
    if (found) return backtrack(trace, d, foundK, N, M);
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/**
 * Walk the trace back from (N, M) at distance D on diagonal kEnd and rebuild
 * the runs, in order, merging consecutive runs of one kind the way the
 * reference's path components merge them.
 */
function backtrack(trace, D, kEnd, N, M) {
  const rev = [];
  let x = N;
  let y = M;
  let k = kEnd;
  for (let d = D; d > 0; d--) {
    const prev = trace[d - 1];
    const prevLen = prev.length;
    let xDel = -1;
    let xIns = -1;
    const iDel = k + d - 2;
    if (iDel >= 0 && iDel < prevLen) {
      const pv = prev[iDel];
      if (pv !== 0 && pv - 1 < N) xDel = pv;
    }
    const iIns = k + d;
    if (iIns >= 0 && iIns < prevLen) {
      const pv = prev[iIns];
      if (pv !== 0 && pv - 1 - (k + 1) < M) xIns = pv - 1;
    }
    const isDel = xDel >= xIns;
    const pk = isDel ? k - 1 : k + 1;
    const px = (isDel ? prev[iDel] : prev[iIns]) - 1;
    const py = px - pk;
    // The snake back: the edit step left (px, py) one line further along one
    // axis, then equal lines ran to (x, y); walk them back to the step.
    let snake = 0;
    while (x > px && y > py) { x--; y--; snake++; }
    if (snake > 0) rev.push({ kind: KEEP, count: snake });
    if (isDel) { rev.push({ kind: DELETE, count: 1 }); x--; }
    else { rev.push({ kind: INSERT, count: 1 }); y--; }
    k = pk;
  }
  let snake = 0;
  while (x > 0 && y > 0) { x--; y--; snake++; }
  if (snake > 0) rev.push({ kind: KEEP, count: snake });
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i];
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** make.fun's own patch of oldText into newText, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;

  // Intern lines to ids. A line with its "\n" and the same text without it are
  // different lines, so the bare last line of a text gets its own id space.
  const ids = new Map();
  const bareIds = new Map();
  let nextId = 0;
  const intern = (part) => {
    let id = ids.get(part);
    if (id === undefined) { id = nextId++; ids.set(part, id); }
    return id;
  };
  const internBare = (part) => {
    let id = bareIds.get(part);
    if (id === undefined) { id = nextId++; bareIds.set(part, id); }
    return id;
  };
  const tokenize = (text) => {
    const parts = text.split('\n');
    const last = parts.length - 1;
    const count = last + (parts[last] !== '' ? 1 : 0);
    const lines = new Array(count);
    const lineIds = new Int32Array(count);
    for (let i = 0; i < last; i++) {
      lines[i] = parts[i] + '\n';
      lineIds[i] = intern(parts[i]);
    }
    if (parts[last] !== '') {
      lines[last] = parts[last];
      lineIds[last] = internBare(parts[last]);
    }
    return { lines, lineIds };
  };
  const ta = tokenize(oldText);
  const tb = tokenize(newText);
  const a = ta.lines;
  const b = tb.lines;
  const ai = ta.lineIds;
  const bi = tb.lineIds;
  const n = a.length;
  const m = b.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ai[n - 1 - suffix] === bi[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...editRuns(ai.subarray(prefix, n - suffix), bi.subarray(prefix, m - suffix)));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, a[at]));
  }
  return out.join('');
}
