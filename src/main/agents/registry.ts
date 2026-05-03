import type { AgentName } from '../../shared/types';
import type { AgentHandler } from './types';
import { bugFixerHandler } from './bug-fixer';
import { qaHunterHandler } from './qa-hunter';
import { manualQaHandler } from './manual-qa';
import { featureBuilderHandler } from './feature-builder';
import { prReviewerHandler } from './pr-reviewer';

/**
 * Central registry. Adding a new agent: implement AgentHandler and register
 * it here. Everything else (orchestrator, scheduler, IPC) is name-agnostic.
 */
const HANDLERS: Record<AgentName, AgentHandler> = {
  'bug-fixer': bugFixerHandler,
  'qa-hunter': qaHunterHandler,
  'manual-qa': manualQaHandler,
  'feature-builder': featureBuilderHandler,
  'pr-reviewer': prReviewerHandler,
};

export function getAgentHandler(name: AgentName): AgentHandler {
  return HANDLERS[name];
}

export function listImplementedAgents(): AgentName[] {
  return Object.keys(HANDLERS) as AgentName[];
}
