export interface Piece {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

// Past this many cell comparisons the whole text is shown as replaced: an announcement is a few hundred words.
const MAX_CELLS = 4_000_000;

/** Word-level difference between two texts (longest common subsequence), whitespace kept. */
export function diffWords(before: string, after: string): Piece[] {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_CELLS) return merge([...(before ? [{ kind: 'del' as const, text: before }] : []), ...(after ? [{ kind: 'add' as const, text: after }] : [])]);

  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: Piece[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i++]! });
    } else {
      out.push({ kind: 'add', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return merge(out);
}

/**
 * Joins neighbours of the same kind and folds a run of edits (with the single spaces between them) into one
 * deletion followed by one insertion, so the screen shows a few spans, not one per word.
 */
function merge(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  const push = (kind: Piece['kind'], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  for (let i = 0; i < pieces.length; ) {
    const p = pieces[i]!;
    if (p.kind === 'same') {
      push('same', p.text);
      i++;
      continue;
    }
    let del = '';
    let add = '';
    while (i < pieces.length) {
      const q = pieces[i]!;
      const bridge = q.kind === 'same' && q.text.trim() === '' && pieces[i + 1] !== undefined && pieces[i + 1]!.kind !== 'same';
      if (q.kind === 'same' && !bridge) break;
      if (q.kind !== 'add') del += q.text;
      if (q.kind !== 'del') add += q.text;
      i++;
    }
    push('del', del);
    push('add', add);
  }
  return out;
}

export const hasChanges = (pieces: Piece[]) => pieces.some((p) => p.kind !== 'same');
