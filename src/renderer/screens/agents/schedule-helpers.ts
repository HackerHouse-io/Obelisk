import type { Agent, ScheduleConfig } from '../../../shared/types';

/* ───────────────────────── Cron preset table (advanced) ───────────────────────── */

export const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every 6 hours', expr: '0 */6 * * *' },
  { label: 'Daily at 02:00', expr: '0 2 * * *' },
  { label: 'Weekdays at 09:00', expr: '0 9 * * 1-5' },
  { label: 'Sundays at 03:00', expr: '0 3 * * 0' },
];

/* ───────────────────────── Defaults & adapters ───────────────────────── */

const ALL_DAYS: [number, number, number, number, number, number, number] = [1, 1, 1, 1, 1, 1, 1];

export function defaultScheduleConfig(agent: Agent): ScheduleConfig {
  if (agent.schedule) return agent.schedule;
  if (agent.scheduleCron) return { mode: 'cron', cron: agent.scheduleCron };
  return {
    mode: 'recurring',
    every: 1,
    unit: 'hour',
    at: '02:00',
    days: ALL_DAYS,
    tz: 'America/Los_Angeles',
  };
}

/* ───────────────────────── Preset chips (simple UI) ───────────────────────── */

export type PresetId = 'off' | '5min' | '10min' | '30min' | 'hourly' | '6hr' | 'daily';

export interface PresetDef {
  id: PresetId;
  label: string;
  build: (prev: ScheduleConfig) => ScheduleConfig;
}

function recur(
  prev: ScheduleConfig,
  every: number,
  unit: 'minute' | 'hour' | 'day',
  at?: string,
): ScheduleConfig {
  const next: ScheduleConfig = {
    mode: 'recurring',
    every,
    unit,
    at: at ?? '00:00',
    days: ALL_DAYS,
    tz: prev.tz ?? 'America/Los_Angeles',
  };
  if (prev.maxConcurrent !== undefined) next.maxConcurrent = prev.maxConcurrent;
  if (prev.maxPerDay !== undefined) next.maxPerDay = prev.maxPerDay;
  if (prev.quietStart !== undefined) next.quietStart = prev.quietStart;
  if (prev.quietEnd !== undefined) next.quietEnd = prev.quietEnd;
  if (prev.pauseLowCredit !== undefined) next.pauseLowCredit = prev.pauseLowCredit;
  return next;
}

export const PRESETS: PresetDef[] = [
  { id: 'off', label: 'Off', build: () => ({ mode: 'manual' }) },
  { id: '5min', label: 'Every 5 min', build: (p) => recur(p, 5, 'minute') },
  { id: '10min', label: 'Every 10 min', build: (p) => recur(p, 10, 'minute') },
  { id: '30min', label: 'Every 30 min', build: (p) => recur(p, 30, 'minute') },
  { id: 'hourly', label: 'Hourly', build: (p) => recur(p, 1, 'hour') },
  { id: '6hr', label: 'Every 6 hours', build: (p) => recur(p, 6, 'hour') },
  // Cron is always evaluated in UTC (see src/main/scheduler/cron.ts) — be
  // explicit so the user isn't surprised by what 09:00 means.
  { id: 'daily', label: 'Daily 09:00 UTC', build: (p) => recur(p, 1, 'day', '09:00') },
];

export function presetToConfig(id: PresetId, prev: ScheduleConfig): ScheduleConfig {
  const def = PRESETS.find((p) => p.id === id);
  if (!def) throw new Error(`Unknown preset id: ${id}`);
  return def.build(prev);
}

export function matchPreset(config: ScheduleConfig): PresetId | null {
  if (config.mode === 'manual') return 'off';
  if (config.mode !== 'recurring') return null;
  const days = config.days ?? ALL_DAYS;
  const allDays = days.every((d) => d === 1);
  if (!allDays) return null;
  const every = config.every ?? 1;
  const at = config.at ?? '00:00';
  if (config.unit === 'minute') {
    if (every === 5) return '5min';
    if (every === 10) return '10min';
    if (every === 30) return '30min';
    return null;
  }
  if (config.unit === 'hour') {
    if (every === 1) return 'hourly';
    if (every === 6) return '6hr';
    return null;
  }
  if (config.unit === 'day' && every === 1 && at === '09:00') return 'daily';
  return null;
}

/* ───────────────────────── Schedule descriptions ───────────────────────── */

export function describeSchedule(s: ScheduleConfig): string {
  if (s.mode === 'manual') return 'Manual only — no automated runs';
  if (s.mode === 'event') return 'On configured repo events';
  if (s.mode === 'cron') {
    const preset = CRON_PRESETS.find((p) => p.expr === s.cron);
    return preset ? preset.label : `Cron · ${s.cron ?? '—'}`;
  }
  const every = s.every ?? 1;
  const unit = (s.unit ?? 'hour') + (every === 1 ? '' : 's');
  const cadence = every === 1 ? `every ${s.unit ?? 'hour'}` : `every ${every} ${unit}`;
  const days = s.days ?? ALL_DAYS;
  const allDays = days.every((d) => d === 1);
  if (s.unit === 'minute' || s.unit === 'hour') {
    return allDays ? cadence : `${cadence}, ${dayList(days)}`;
  }
  return `${cadence} at ${s.at ?? '00:00'}${allDays ? '' : ', ' + dayList(days)}`;
}

export function dayList(days: number[]): string {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (days.slice(0, 5).every((d) => d) && !days[5] && !days[6]) return 'weekdays';
  if (!days.slice(0, 5).some((d) => d) && days[5] && days[6]) return 'weekends';
  return days
    .map((d, i) => (d ? labels[i] : null))
    .filter(Boolean)
    .join(', ');
}

export function toCron(s: ScheduleConfig): string | null {
  if (s.mode !== 'recurring') return null;
  const every = s.every ?? 1;
  const at = s.at ?? '00:00';
  const [hStr, mStr] = at.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const days = s.days ?? ALL_DAYS;
  const dows = days.every((d) => d === 1)
    ? '*'
    : days
        .map((d, i) => (d ? (i + 1) % 7 : null))
        .filter((v): v is number => v !== null)
        .join(',');
  if (s.unit === 'minute') return `*/${every} * * * ${dows}`;
  if (s.unit === 'hour') return `0 */${every} * * ${dows}`;
  if (s.unit === 'day') return `${m} ${h} */${every} * *`;
  if (s.unit === 'week') return `${m} ${h} * * ${dows}`;
  return null;
}

export function computeNextRuns(
  s: ScheduleConfig,
  count: number,
): { absolute: string; relative: string }[] {
  if (s.mode === 'manual') return [];
  if (s.mode === 'event') {
    return [
      {
        absolute: 'On next matching event',
        relative: `triggers: ${(s.events ?? []).length} configured`,
      },
    ];
  }
  const out: { absolute: string; relative: string }[] = [];
  const now = new Date();
  let cursor = now;
  for (let i = 0; i < count; i++) {
    let next: Date;
    if (s.mode === 'cron') {
      const inc =
        s.cron && s.cron.startsWith('*/15')
          ? 15
          : s.cron === '0 * * * *'
            ? 60
            : s.cron === '0 */6 * * *'
              ? 360
              : s.cron === '0 2 * * *'
                ? 1440
                : 60;
      next = new Date(cursor.getTime() + inc * 60 * 1000);
    } else if (s.unit === 'minute') {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 60 * 1000);
    } else if (s.unit === 'hour') {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 3600 * 1000);
    } else if (s.unit === 'day') {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 86400 * 1000);
      const [h, m] = (s.at ?? '02:00').split(':').map(Number);
      next.setHours(h ?? 0, m ?? 0, 0, 0);
    } else {
      next = new Date(cursor.getTime() + (s.every ?? 1) * 7 * 86400 * 1000);
    }
    cursor = next;
    out.push({ absolute: formatAbsolute(next), relative: formatRelative(next, now) });
  }
  return out;
}

export function formatAbsolute(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 86400000);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `Today · ${time}`;
  if (isTomorrow) return `Tomorrow · ${time}`;
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} · ${time}`;
}

export function formatRelative(d: Date, now: Date): string {
  const ms = d.getTime() - now.getTime();
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const dy = Math.floor(h / 24);
  if (dy > 0) return `in ${dy}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m % 60}m`;
  if (m > 0) return `in ${m}m`;
  return `in ${s}s`;
}

/* Renderer-side relative formatter for `Agent.nextFireAt` (an ISO string).
   Used by the live "Next: in 4m 12s" pill in `SchedulePresetCard`. */
export function formatNextFireRelative(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatRelative(d, now);
}

export function scheduleSummary(agent: Agent): string {
  if (!agent.enabled) return 'paused';
  if (agent.schedule) return describeSchedule(agent.schedule);
  if (agent.scheduleCron) {
    const preset = CRON_PRESETS.find((p) => p.expr === agent.scheduleCron);
    return preset ? preset.label.toLowerCase() : `cron · ${agent.scheduleCron}`;
  }
  return 'default schedule';
}
