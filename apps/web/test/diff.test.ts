import { describe, expect, it } from 'vitest';
import { diffWords, hasChanges } from '../src/diff';

describe('diffWords', () => {
  it('reports identical text as unchanged', () => {
    const d = diffWords('The Board announces results.', 'The Board announces results.');
    expect(d).toEqual([{ kind: 'same', text: 'The Board announces results.' }]);
    expect(hasChanges(d)).toBe(false);
  });

  it('marks an inserted and a replaced word', () => {
    const d = diffWords('Revenue grew 8% in the half.', 'Revenue grew a strong 9% in the half.');
    expect(d.filter((p) => p.kind === 'add').map((p) => p.text.trim())).toEqual(['a strong 9%']);
    expect(d.filter((p) => p.kind === 'del').map((p) => p.text.trim())).toEqual(['8%']);
    expect(hasChanges(d)).toBe(true);
  });

  it('rebuilds both sides exactly from the pieces', () => {
    const before = 'Alice was appointed as Chief Executive.\n\nThe appointment is effective 1 January.';
    const after = 'Alice was appointed as Chief Financial Officer.\n\nThe appointment is effective 1 February.';
    const d = diffWords(before, after);
    expect(d.filter((p) => p.kind !== 'add').map((p) => p.text).join('')).toBe(before);
    expect(d.filter((p) => p.kind !== 'del').map((p) => p.text).join('')).toBe(after);
  });

  it('handles an empty side', () => {
    expect(diffWords('', 'new text')).toEqual([{ kind: 'add', text: 'new text' }]);
    expect(diffWords('old text', '')).toEqual([{ kind: 'del', text: 'old text' }]);
  });

  it('falls back to replaced for texts too large to compare word by word', () => {
    const big = 'word '.repeat(2500);
    const d = diffWords(big, `${big}extra `.replace('word', 'other'));
    expect(d.map((p) => p.kind)).toEqual(['del', 'add']);
  });
});
