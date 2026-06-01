import { describe, it, expect } from 'vitest';
import type { getGithub } from '../../src/main/github/client';
import { fetchFailingChecks } from '../../src/main/agents/pr-reviewer';

type Gh = Awaited<ReturnType<typeof getGithub>>;

function mockGh(opts: {
  checkRuns?: Array<{ name: string; status: string; conclusion: string | null }>;
  statuses?: Array<{ context: string; state: string }>;
  throwChecks?: boolean;
  throwStatuses?: boolean;
}): Gh {
  return {
    checks: {
      listForRef: async () => {
        if (opts.throwChecks) throw new Error('checks api down');
        return { data: { check_runs: opts.checkRuns ?? [] } };
      },
    },
    repos: {
      getCombinedStatusForRef: async () => {
        if (opts.throwStatuses) throw new Error('status api down');
        return { data: { statuses: opts.statuses ?? [] } };
      },
    },
  } as unknown as Gh;
}

describe('fetchFailingChecks', () => {
  it('collects failing check runs AND legacy commit statuses, ignoring green/in-progress', async () => {
    const gh = mockGh({
      checkRuns: [
        { name: 'frontend-tests', status: 'completed', conclusion: 'failure' },
        { name: 'e2e', status: 'completed', conclusion: 'timed_out' },
        { name: 'lint', status: 'completed', conclusion: 'success' },
        { name: 'still-running', status: 'in_progress', conclusion: null },
      ],
      statuses: [
        { context: 'ci/legacy', state: 'error' },
        { context: 'ci/ok', state: 'success' },
      ],
    });
    const names = await fetchFailingChecks(gh, 'o', 'r', 'sha');
    expect(names.sort()).toEqual(['ci/legacy', 'e2e', 'frontend-tests']);
  });

  it('returns [] when gh is null (offline)', async () => {
    expect(await fetchFailingChecks(null as unknown as Gh, 'o', 'r', 'sha')).toEqual([]);
  });

  it('is resilient — API errors yield [] rather than throwing', async () => {
    const gh = mockGh({ throwChecks: true, throwStatuses: true });
    expect(await fetchFailingChecks(gh, 'o', 'r', 'sha')).toEqual([]);
  });
});
