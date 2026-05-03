import type { AgentName } from '../../shared/types';
import type { AgentHandler } from './types';
import { bugFixerHandler } from './bug-fixer';
import { qaHunterHandler } from './qa-hunter';
import { manualQaHandler } from './manual-qa';
import { featureBuilderHandler } from './feature-builder';

/**
 * Central registry. Adding a new agent: implement AgentHandler and register
 * it here. Everything else (orchestrator, scheduler, IPC) is name-agnostic.
 */
const HANDLERS: Partial<Record<AgentName, AgentHandler>> = {
  'bug-fixer': bugFixerHandler,
  'qa-hunter': qaHunterHandler,
  'manual-qa': manualQaHandler,
  'feature-builder': featureBuilderHandler,
  // Phase 8: 'pr-reviewer'
};

export function getAgentHandler(name: AgentName): AgentHandler | null {
  return HANDLERS[name] ?? null;
}

export function listImplementedAgents(): AgentName[] {
  return Object.keys(HANDLERS) as AgentName[];
}
