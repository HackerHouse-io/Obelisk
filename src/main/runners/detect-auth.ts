/**
 * Both Claude Code and Codex emit recognizable "you are signed out" signals
 * before they exit non-zero. We classify those before falling through to
 * the generic non_zero_exit reason so the orchestrator can:
 *   1. tag the run with RUNNER_LOGIN_REQUIRED instead of INTERNAL,
 *   2. auto-pause the agent's schedule (skipping the 3-strike circuit
 *      breaker — login is terminal until the user fixes it),
 *   3. show a Copy-the-command action card in the failed-run drawer plus a
 *      persistent shell banner.
 *
 * Patterns are intentionally tolerant — we match real strings observed in
 * the wild ("Not logged in · Please run /login") plus the obvious wording
 * the CLIs may pivot to. False negatives degrade to INTERNAL, which is
 * acceptable; false positives are the failure mode to avoid, hence the
 * narrow phrases.
 */

const PATTERNS: RegExp[] = [
  /not\s+logged\s+in/i,
  /please\s+(?:run|use)\s+\/?login/i,
  /please\s+sign\s+in/i,
  /you\s+are\s+not\s+(?:authenticated|signed[\s-]?in)/i,
  /not\s+authenticated/i,
  /authentication\s+required/i,
  /run\s+`?codex\s+login`?/i,
  /run\s+`?claude\s+login`?/i,
  /token\s+(?:expired|invalid|revoked)/i,
  /401\s+unauthori[sz]ed/i,
];

/**
 * Returns true when the combined stdout/stderr from a CLI invocation looks
 * like an "you must log in" failure. Caller passes whatever it has.
 */
export function looksLikeAuthRequired(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`;
  return PATTERNS.some((p) => p.test(haystack));
}
