import type { AgentName } from '../../shared/types';
import type { AgentHandler } from './types';
import { bugFixerHandler } from './bug-fixer';

/**
 * Central registry. Adding a new agent: implement AgentHandler and register
 * it here. Everything else (orchestrator, scheduler, IPC) is name-agnostic.
 */
const HANDLERS: Partial<Record<AgentName, AgentHandler>> = {
  'bug-fixer': bugFixerHandler,
  // Phase 5+: 'qa-hunter', 'manual-qa', 'feature-builder', 'pr-reviewer'
};

export function getAgentHandler(name: AgentName): AgentHandler | null {
  return HANDLERS[name] ?? null;
}

export function listImplementedAgents(): AgentName[] {
  return Object.keys(HANDLERS) as AgentName[];
}
