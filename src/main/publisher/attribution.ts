import { simpleGit, type SimpleGit } from 'simple-git';
import type { AgentName, AttributionMode } from '../../shared/types';

export interface AttributionConfig {
  mode: AttributionMode;
  /** Required when mode='bot' or 'custom'. */
  customName?: string;
  customEmail?: string;
}

export interface ResolvedAttribution {
  authorName: string;
  authorEmail: string;
  /** "Co-Authored-By: Obelisk <noreply@local>" trailer text. */
  coAuthoredBy: string;
}

const COAUTHOR_TRAILER = 'Co-Authored-By: Obelisk <noreply@local>';

/**
 * Resolve commit attribution per repos.attribution_mode (TECH_DESIGN.md §7.1).
 * - user (default): inherit local git config; commits land under the connected user's profile
 * - bot: override with a bot identity stored in app Settings
 * - custom: per-repo alternate name/email
 */
export async function resolveAttribution(
  worktreePath: string,
  cfg: AttributionConfig,
): Promise<ResolvedAttribution> {
  if (cfg.mode === 'bot' || cfg.mode === 'custom') {
    return {
      authorName: cfg.customName ?? 'Obelisk Bot',
      authorEmail: cfg.customEmail ?? 'bot@obelisk.local',
      coAuthoredBy: COAUTHOR_TRAILER,
    };
  }
  const git = simpleGit(worktreePath);
  const name = (await git.raw(['config', 'user.name']).catch(() => '')).trim();
  const email = (await git.raw(['config', 'user.email']).catch(() => '')).trim();
  return {
    authorName: name || 'Unknown',
    authorEmail: email || 'unknown@local',
    coAuthoredBy: COAUTHOR_TRAILER,
  };
}

/**
 * Render the commit message: subject + body + trailers.
 * Subject MUST end with `[obelisk:<agent-name>]` so commits are greppable
 * (PRD §7.1).
 */
export function renderCommitMessage(input: {
  subject: string;
  agentName: AgentName;
  body?: string;
  attribution: ResolvedAttribution;
  /** Pass true for bot-churn commits (records, dashboards, etc.). */
  skipCi?: boolean;
}): string {
  const tagged = ensureAgentTag(input.subject, input.agentName);
  const subject = input.skipCi ? `${tagged} [skip ci]` : tagged;
  const lines: string[] = [subject];
  if (input.body && input.body.trim().length > 0) {
    lines.push('', input.body.trim());
  }
  lines.push('', input.attribution.coAuthoredBy);
  return lines.join('\n');
}

function ensureAgentTag(subject: string, agentName: AgentName): string {
  const tag = `[obelisk:${agentName}]`;
  if (subject.includes(tag)) return subject;
  return `${subject.replace(/\s+\[obelisk:[a-z-]+\]\s*$/i, '').trim()} ${tag}`;
}

export async function applyGitConfig(git: SimpleGit, attr: ResolvedAttribution): Promise<void> {
  await git.addConfig('user.name', attr.authorName);
  await git.addConfig('user.email', attr.authorEmail);
}
