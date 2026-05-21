import { buildCodexExecArgs } from '../../prompt-compiler/codex-layout';
import { resolveRunnerModel } from '../../runners/effective-default';

/**
 * Argv for `claude -p` (one-shot print mode). Pipes its prompt via stdin
 * and exits with a single response — used by feature paths that need a
 * short, text-only completion from Claude Code outside the agent loop
 * (coverage map generation, follow-up refine, future small prompts).
 *
 * Defaults to `--output-format text` since the typical caller wants the
 * response text directly. Pass `stream-json` for callers that wrap the
 * output in `ClaudeStreamParser`.
 */
export function buildOneShotClaudeArgs(
  opts: {
    systemPrompt?: string;
    modelOverride?: string | null;
    outputFormat?: 'text' | 'stream-json';
  } = {},
): string[] {
  const args = ['-p'];
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
  args.push('--output-format', opts.outputFormat ?? 'text');
  const model = resolveRunnerModel('claude', opts.modelOverride);
  if (model) args.unshift('--model', model);
  return args;
}

/**
 * Argv for `codex exec` in a one-shot text task (no workspace writes).
 * Thin wrapper around `buildCodexExecArgs` that pins read-only sandbox
 * + medium reasoning, the right defaults for refine-style prompts.
 */
export function buildOneShotCodexArgs(
  opts: {
    modelOverride?: string | null;
    reasoning?: 'low' | 'medium' | 'high';
  } = {},
): string[] {
  return buildCodexExecArgs({
    sandbox: 'read-only',
    reasoning: opts.reasoning ?? 'medium',
    modelOverride: opts.modelOverride,
  });
}
