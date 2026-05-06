import type { AgentName } from '../shared/types';

const AGENT_LABELS: Record<AgentName, string> = {
  'qa-hunter': 'QA Hunter',
  'manual-qa': 'Manual QA',
  'bug-fixer': 'Bug Fixer',
  'feature-builder': 'Feature Builder',
  'pr-reviewer': 'PR Reviewer',
  'ios-qa-pilot': 'iOS QA Pilot',
};

export function labelForAgent(name: AgentName): string {
  return AGENT_LABELS[name];
}

export function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
