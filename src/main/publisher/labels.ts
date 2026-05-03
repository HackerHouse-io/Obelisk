export const OBELISK_LABELS = {
  inProgress: 'obelisk:in-progress',
  fix: 'obelisk:fix',
  feature: 'obelisk:feature',
  automerge: 'obelisk:automerge',
  continueRun: 'obelisk:continue',
  falsePositive: 'obelisk:false-positive',
  cloudOnly: 'obelisk:cloud-only',
  qaBug: 'qa-bug',
  iosQaBug: 'ios-qa-bug',
} as const;

export type ObeliskLabel = (typeof OBELISK_LABELS)[keyof typeof OBELISK_LABELS];
