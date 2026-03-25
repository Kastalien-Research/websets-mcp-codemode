import { describe, it, expect, beforeEach } from 'vitest';
import { searchCatalog, resetCatalog } from '../catalog.js';

beforeEach(() => {
  resetCatalog();
});

describe('searchCatalog', () => {
  describe('brief detail level', () => {
    it('returns matching operations for keyword query', () => {
      const result = searchCatalog('create');
      expect(result.total).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('name');
      expect(result.results[0]).toHaveProperty('summary');
      // brief should NOT have params or schema
      expect(result.results[0]).not.toHaveProperty('params');
      expect(result.results[0]).not.toHaveProperty('schema');
      // Should find multiple create operations
      const names = result.results.map((r: any) => r.name);
      expect(names.some((n: string) => n.includes('create'))).toBe(true);
    });

    it('returns all operations for a domain query', () => {
      const result = searchCatalog('', { domain: 'websets' });
      expect(result.total).toBeGreaterThanOrEqual(9); // websets has 9 ops
      const names = result.results.map((r: any) => r.name);
      expect(names.every((n: string) => n.startsWith('websets.'))).toBe(true);
    });

    it('domain filter restricts results', () => {
      const result = searchCatalog('create', { domain: 'websets' });
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('websets.create');
      expect(names.every((n: string) => n.startsWith('websets.'))).toBe(true);
    });

    it('respects limit', () => {
      const result = searchCatalog('create', { limit: 3 });
      expect(result.showing).toBeLessThanOrEqual(3);
      expect(result.results.length).toBeLessThanOrEqual(3);
    });

    it('includes hint when results are truncated', () => {
      const result = searchCatalog('create', { limit: 1 });
      if (result.total > 1) {
        expect(result.hint).toBeDefined();
      }
    });

    it('returns empty results for nonsense query', () => {
      const result = searchCatalog('xyzzy12345nonexistent');
      expect(result.total).toBe(0);
      expect(result.results).toEqual([]);
    });
  });

  describe('detailed detail level', () => {
    it('includes params in results', () => {
      const result = searchCatalog('websets.create', { detail: 'detailed', limit: 1 });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('params');
      expect(Array.isArray((result.results[0] as any).params)).toBe(true);
    });
  });

  describe('full detail level', () => {
    it('includes schema in results', () => {
      const result = searchCatalog('websets.get', { detail: 'full', limit: 1 });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('schema');
    });
  });

  describe('workflow entries', () => {
    it('includes workflows in search results', () => {
      const result = searchCatalog('workflow');
      expect(result.total).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names.some((n: string) => n.startsWith('workflow.'))).toBe(true);
    });

    it('finds specific workflow by name', () => {
      const result = searchCatalog('harvest');
      expect(result.total).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names.some((n: string) => n.includes('harvest'))).toBe(true);
    });
  });
});
