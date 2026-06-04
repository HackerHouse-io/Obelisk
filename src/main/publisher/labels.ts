export const OBELISK_LABELS = {
  inProgress: 'obelisk:in-progress',
  fix: 'obelisk:fix',
  feature: 'obelisk:feature',
  automerge: 'obelisk:automerge',
  continueRun: 'obelisk:continue',
  falsePositive: 'obelisk:false-positive',
  cloudOnly: 'obelisk:cloud-only',
  // Applied by the rebase-on-dirty sweep (and CI-retry escalation) when a PR
  // can't be auto-resolved and needs a human to step in.
  needsHuman: 'obelisk:needs-human',
  qaBug: 'qa-bug',
  iosQaBug: 'ios-qa-bug',
  // Provenance label the UI/UX Expert stamps on every finding. Constant across
  // both routing paths (obelisk:fix → Bug Fixer, obelisk:feature → Feature
  // Builder) so it never affects deriveKind — used only for filtering and the
  // UX coverage tab.
  ux: 'ux',
} as const;

export type ObeliskLabel = (typeof OBELISK_LABELS)[keyof typeof OBELISK_LABELS];
