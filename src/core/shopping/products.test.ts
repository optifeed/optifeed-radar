import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUCTS,
  ProductListError,
  parseProductsFile,
  parseProductsFlag,
  resolveProducts,
} from './products.js';

describe('parseProductsFlag', () => {
  it('keeps the merchant order and trims each name', () => {
    expect(parseProductsFlag(' Aria 2, Presto X ,Brew Mini ')).toEqual([
      { name: 'Aria 2' },
      { name: 'Presto X' },
      { name: 'Brew Mini' },
    ]);
  });

  it('drops blank entries from a trailing or doubled comma', () => {
    expect(parseProductsFlag('Aria 2,,Presto X,')).toEqual([
      { name: 'Aria 2' },
      { name: 'Presto X' },
    ]);
  });
});

describe('parseProductsFile', () => {
  it('reads names, aliases and descriptors', () => {
    const yaml = [
      'products:',
      '  - name: Aria 2',
      '    aliases: [Aria II, Aria Two]',
      '    descriptor: quiet home espresso machine',
      '  - name: Presto X',
    ].join('\n');
    expect(parseProductsFile(yaml)).toEqual([
      {
        name: 'Aria 2',
        aliases: ['Aria II', 'Aria Two'],
        descriptor: 'quiet home espresso machine',
      },
      { name: 'Presto X' },
    ]);
  });

  it('accepts a bare list of names', () => {
    expect(parseProductsFile('- Aria 2\n- Presto X\n')).toEqual([
      { name: 'Aria 2' },
      { name: 'Presto X' },
    ]);
  });

  it('rejects malformed YAML with a typed error', () => {
    expect(() => parseProductsFile('products: [oops', 'products.yml')).toThrow(
      ProductListError,
    );
  });

  it('rejects an entry with no name', () => {
    expect(() =>
      parseProductsFile('products:\n  - descriptor: a thing\n'),
    ).toThrow(ProductListError);
  });

  it('rejects a schema_version it does not support', () => {
    const yaml = 'schema_version: "0.1"\nproducts:\n  - name: Aria 2\n';
    expect(() => parseProductsFile(yaml)).toThrow(ProductListError);
  });
});

describe('resolveProducts', () => {
  it('caps the list and says what it dropped', () => {
    const many = Array.from({ length: MAX_PRODUCTS + 3 }, (_, i) => ({
      name: `P${i + 1}`,
    }));
    const resolved = resolveProducts(many);
    expect(resolved.products).toHaveLength(MAX_PRODUCTS);
    expect(resolved.products[0]?.name).toBe('P1');
    expect(resolved.notes.join(' ')).toContain('3');
  });

  it('de-dupes case-insensitively, keeping the first (higher-ranked) entry', () => {
    const resolved = resolveProducts([
      { name: 'Aria 2', descriptor: 'espresso machine' },
      { name: 'aria 2' },
      { name: 'Presto X' },
    ]);
    expect(resolved.products).toEqual([
      { name: 'Aria 2', descriptor: 'espresso machine' },
      { name: 'Presto X' },
    ]);
    expect(resolved.notes.join(' ').toLowerCase()).toContain('duplicate');
  });

  it('keeps the input order, which only decides what the cap drops', () => {
    const resolved = resolveProducts([{ name: 'A' }, { name: 'B' }]);
    expect(resolved.products.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('rejects an empty list', () => {
    expect(() => resolveProducts([])).toThrow(ProductListError);
  });
});
