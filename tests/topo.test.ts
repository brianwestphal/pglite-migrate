import { describe, expect, it } from 'vitest';

import { topologicalSort } from '../src/transfer.js';
import type { ForeignKey, TableInfo } from '../src/types.js';

function table(name: string): TableInfo {
  return { schema: 'public', name, columns: [{ name: 'id', type: 'integer' }] };
}

function fk(child: string, parent: string): ForeignKey {
  return { child: `public.${child}`, parent: `public.${parent}` };
}

describe('topologicalSort', () => {
  it('orders parents before children', () => {
    const tables = [table('books'), table('authors')];
    const { ordered, cycles } = topologicalSort(tables, [fk('books', 'authors')]);

    expect(cycles).toEqual([]);
    expect(ordered.map((t) => t.name)).toEqual(['authors', 'books']);
  });

  it('handles a multi-level chain', () => {
    const tables = [table('c'), table('a'), table('b')];
    const fks = [fk('c', 'b'), fk('b', 'a')];
    const { ordered } = topologicalSort(tables, fks);

    expect(ordered.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('ignores foreign keys to unknown tables', () => {
    const tables = [table('a')];
    const { ordered, cycles } = topologicalSort(tables, [fk('a', 'missing')]);

    expect(cycles).toEqual([]);
    expect(ordered.map((t) => t.name)).toEqual(['a']);
  });

  it('reports cycles instead of looping forever', () => {
    const tables = [table('a'), table('b')];
    const fks = [fk('a', 'b'), fk('b', 'a')];
    const { ordered, cycles } = topologicalSort(tables, fks);

    expect(cycles).toEqual(['public.a', 'public.b']);
    expect(ordered).toHaveLength(2);
  });

  it('does not treat self-references as cycles', () => {
    const tables = [table('tree')];
    const { ordered, cycles } = topologicalSort(tables, [fk('tree', 'tree')]);

    expect(cycles).toEqual([]);
    expect(ordered.map((t) => t.name)).toEqual(['tree']);
  });
});
