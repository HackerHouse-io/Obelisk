import { describe, it, expect } from 'vitest';
import { normalizeCaseScopes } from '../../src/main/test-plans/generate';
import type { TestPlanBlock } from '../../src/shared/types';

function caseBlock(scope: string[] | null): Extract<TestPlanBlock, { kind: 'case' }> {
  return { kind: 'case', id: 'c', title: 't', expected: null, repro: null, severity: 'P0', scope };
}

describe('normalizeCaseScopes', () => {
  const allowed = ['smoke', 'integrations', 'chat-voice'];

  it('drops off-map labels and ensures the target feature is present', () => {
    const blocks = [caseBlock(['electron', 'foo', 'integrations'])];
    normalizeCaseScopes(blocks, allowed, 'integrations');
    expect((blocks[0] as { scope: string[] }).scope).toEqual(['integrations']);
  });

  it('keeps one other valid map label alongside the feature', () => {
    const blocks = [caseBlock(['chat-voice', 'foo'])];
    normalizeCaseScopes(blocks, allowed, 'integrations');
    expect((blocks[0] as { scope: string[] }).scope).toEqual(['integrations', 'chat-voice']);
  });

  it('falls back to the feature label when nothing valid survives', () => {
    const blocks = [caseBlock(['electron', 'agent-runs'])];
    normalizeCaseScopes(blocks, allowed, 'integrations');
    expect((blocks[0] as { scope: string[] }).scope).toEqual(['integrations']);
  });

  it('whole-app (no feature) keeps map labels, falls back to smoke', () => {
    const a = [caseBlock(['integrations', 'foo'])];
    normalizeCaseScopes(a, allowed, null);
    expect((a[0] as { scope: string[] }).scope).toEqual(['integrations']);

    const b = [caseBlock(['foo', 'bar'])];
    normalizeCaseScopes(b, allowed, null);
    expect((b[0] as { scope: string[] }).scope).toEqual(['smoke']);
  });

  it('leaves section blocks untouched', () => {
    const blocks: TestPlanBlock[] = [{ kind: 'section', id: 's', title: 'Smoke' }, caseBlock(['x'])];
    normalizeCaseScopes(blocks, allowed, 'integrations');
    expect(blocks[0]).toEqual({ kind: 'section', id: 's', title: 'Smoke' });
  });
});
