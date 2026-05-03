import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { ulid } from 'ulid';
import type { Repo } from '../../../shared/types';
import { getGithub } from '../../github/client';
import { ObeliskError } from '../../../shared/errors';
import { OBELISK_LABELS } from '../../publisher/labels';
import {
  resolveAttribution,
  applyGitConfig,
  renderCommitMessage,
} from '../../publisher/attribution';
import { getSetting, setSetting } from '../../db/settings';
import { bootstrapPlaybook, type PlaybookFile } from './index';

/**
 * Run the bootstrapper for a freshly connected repo.
 *
 * - Observe mode: write the generated files to a per-repo draft store
 *   (settings(scope='repo:<id>', key='playbook.draft')) so the renderer
 *   can preview them without touching the repo.
 * - Higher modes: write the files to a new branch in the local clone,
 *   commit with the standard attribution + [obelisk:playbook-bootstrapper]
 *   subject, push, and open a draft PR.
 */
export interface BootstrapPublishOutput {
  mode: 'preview' | 'pr';
  files: PlaybookFile[];
  prNumber?: number;
}

export async function bootstrapAndPublish(repo: Repo): Promise<BootstrapPublishOutput> {
  const result = bootstrapPlaybook({ repo });

  if (repo.mode === 'observe') {
    setSetting(`repo:${repo.id}`, 'playbook.draft', {
      generatedAt: new Date().toISOString(),
      files: result.files,
      framework: result.framework,
      criticalFlows: result.criticalFlows,
    });
    return { mode: 'preview', files: result.files };
  }

  const gh = await getGithub();
  if (!gh) {
    throw new ObeliskError('AUTH_REQUIRED', 'Sign in to GitHub before bootstrapping the playbook.');
  }
  const [owner, name] = repo.githubFullName.split('/');
  if (!owner || !name) {
    throw new ObeliskError('INVALID_INPUT', `Bad full name: ${repo.githubFullName}`);
  }

  const branch = `obelisk/playbook-${ulid().slice(-10).toLowerCase()}`;
  const git = simpleGit(repo.localPath);

  // Branch from the default branch in the user's local clone.
  await git.fetch().catch(() => undefined);
  await git.checkout(['-b', branch, repo.defaultBranch]);

  for (const f of result.files) {
    const target = join(repo.localPath, f.path);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      // Don't overwrite a hand-edited playbook on subsequent runs.
      continue;
    }
    writeFileSync(target, f.contents, 'utf8');
  }

  const attr = await resolveAttribution(repo.localPath, { mode: 'user' });
  await applyGitConfig(git, attr);
  await git.add('qa/');
  const commitMessage = renderCommitMessage({
    subject: 'chore(obelisk): bootstrap QA playbook',
    agentName: 'qa-hunter', // bootstrapper is run on QA Hunter's behalf
    body: `Generated playbook for ${repo.githubFullName} (framework: ${result.framework}, ${result.criticalFlows.length} critical flows).`,
    attribution: attr,
  });
  await git.commit(commitMessage, { '--no-verify': null });

  // Push + open PR.
  await git.push(['--set-upstream', 'origin', branch]);
  const created = await gh.pulls.create({
    owner,
    repo: name,
    title: 'chore(obelisk): bootstrap QA playbook',
    body: renderPrBody(result.framework, result.criticalFlows.length),
    head: branch,
    base: repo.defaultBranch,
    draft: true,
  });
  await gh.issues
    .addLabels({
      owner,
      repo: name,
      issue_number: created.data.number,
      labels: [OBELISK_LABELS.inProgress],
    })
    .catch(() => undefined);

  // Restore the user's working branch.
  await git.checkout(repo.defaultBranch).catch(() => undefined);

  return { mode: 'pr', files: result.files, prNumber: created.data.number };
}

/**
 * Read the cached preview (Observe-mode draft) for a repo, or null if no
 * bootstrap run has been recorded yet.
 */
export function getPlaybookDraft(repoId: string): {
  generatedAt: string;
  files: PlaybookFile[];
  framework: string;
  criticalFlows: string[];
} | null {
  return getSetting(`repo:${repoId}`, 'playbook.draft');
}

function renderPrBody(framework: string, flowCount: number): string {
  return [
    '> Authored by Obelisk (Playbook Bootstrapper) on behalf of the connected account.',
    '>',
    '> This PR seeds your `qa/` directory so Manual QA has a written contract to test against.',
    '> Edit any file freely before merging — Obelisk will not overwrite hand-edited files on subsequent runs.',
    '',
    '## What this adds',
    '',
    `- Detected framework: \`${framework}\``,
    `- Stub Playwright flow files: ${flowCount}`,
    '- `qa/product-map.md`, `qa/critical-flows.md`, `qa/expected-behavior.md`, `qa/bug-rules.md`, `qa/non-bugs.md`, `qa/test-users.md`',
    '',
    '## Next steps',
    '',
    '1. Fill in real seed-user credentials in `qa/test-users.md`.',
    '2. Flesh out each `qa/playwright/flows/*.flow.md` with the actual steps.',
    '3. Merge this PR — Manual QA will start testing against it on the next nightly run.',
  ].join('\n');
}
