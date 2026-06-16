import { describe, expect, it } from 'vitest';

import { quoteIdent, quoteLiteral, quoteQualified } from '../src/ident.js';

describe('quoteIdent', () => {
  it('wraps a plain identifier in double quotes', () => {
    expect(quoteIdent('users')).toBe('"users"');
  });

  it('doubles embedded double-quotes', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('preserves mixed case (so it is not folded to lower-case)', () => {
    expect(quoteIdent('MyTable')).toBe('"MyTable"');
  });

  it('quotes a reserved word so it is usable as an identifier', () => {
    expect(quoteIdent('select')).toBe('"select"');
  });
});

describe('quoteQualified', () => {
  it('produces "schema"."name"', () => {
    expect(quoteQualified('public', 'users')).toBe('"public"."users"');
  });

  it('quotes each part independently', () => {
    expect(quoteQualified('My Schema', 'odd"name')).toBe('"My Schema"."odd""name"');
  });
});

describe('quoteLiteral', () => {
  it('wraps a string in single quotes', () => {
    expect(quoteLiteral('public.users')).toBe("'public.users'");
  });

  it('doubles embedded single-quotes', () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });
});
