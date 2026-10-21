/** The API's shapes, as the web app reads them (apps/api/src/views.ts, routes/*). */
export interface Task {
  id: string;
  path: string;
  line: number;
  hash: string;
  status: 'open' | 'done' | 'cancelled';
  title: string;
  due: string | null;
  dueInferred: boolean;
  reminder: string | null;
  priority: string | null;
  recur: string | null;
  done: string | null;
  slugs: string[];
  tags: string[];
  capture: string | null;
  section: string;
  readonly: boolean;
  list: string;
  kind: string;
  /** a task group's child (round-2 brief §10): its parent's id; the due date may be the parent's */
  parentId?: string | null;
  dueInherited?: boolean;
  /** a group's parent row carries its children */
  group?: { total: number; done: number; children: Task[] } | null;
}

export interface EventItem {
  id: string;
  path: string;
  line: number;
  hash: string;
  date: string;
  time: string | null;
  text: string;
}

export interface Draft<P = unknown> {
  id: string;
  kind: 'morning_plan' | 'evening_review' | 'habit_nudge';
  date: string;
  ref: string | null;
  status: 'generating' | 'pending' | 'approved' | 'dismissed' | 'superseded';
  payload: P;
  model: string | null;
  promptTokens: number | null;
  sources: string[];
  generatedAt: string;
  fallback: boolean;
  fallbackReason: string | null;
  /** 'hermes': written by (or waiting for) Hermes through the integration API (ADR-86) */
  via?: 'hermes' | null;
}

export interface PlanPayload {
  headline: string;
  focus: { text: string; source_task_id: string | null; new: boolean }[];
  notes: string[];
}

export interface ReviewPayload {
  review: string;
  unsorted: { capture_file: string; suggestion: 'task' | 'note' | 'ignore'; text: string }[];
  tomorrow: { headline: string; focus: string[] };
}

export interface HabitLog {
  date: string;
  value: 'clean' | 'slip' | 'skip';
  note: string | null;
}

export interface Habit {
  slug: string;
  path: string;
  title: string;
  kind: 'quit' | 'build';
  status: string;
  schedule: string;
  started: string | null;
  why: string | null;
  private: boolean;
  scheduledToday: boolean;
  today: 'clean' | 'slip' | 'skip' | null;
  streak: number;
  best: number;
  logs: HabitLog[];
}

export interface Capture {
  path: string;
  slug: string;
  title: string;
  date: string | null;
  time: string | null;
  tags: string[];
  needsReview: boolean;
  hasTask: boolean;
  decision: string | null;
  preview: string;
}

export interface CheckinLine {
  time: string;
  sleep?: number;
  workout?: boolean;
  prayers?: number;
  extra: string[];
}

export interface MoodLine {
  time: string;
  mood?: number;
  energy?: number;
  note?: string;
}

export interface Today {
  date: string;
  hm: string;
  moment: 'morning' | 'midday' | 'evening';
  hijri: string;
  hijriDay: number;
  prayers: Record<'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha', string>;
  next: { name: string; label: string; time: string; at: string; date: string };
  plan: { headline: string | null; bullets: string[] };
  draft: Draft<PlanPayload> | null;
  review: Draft<ReviewPayload> | null;
  tomorrowDraft: Draft<PlanPayload> | null;
  focus: Task[];
  remaining: Task[];
  doneToday: Task[];
  overdue: Task[];
  counters: { doneToday: number; doneWeek: number; longestStreak: number; planned: number };
  events: { today: EventItem[]; upcoming: EventItem[] };
  habits: Habit[];
  /** private habit names (titles and slugs): Privacy mode curtains them in plans and drafts (ADR-63) */
  privateNames?: string[];
  inbox: { needsReview: number; sinceMorning: number };
  checkin: { checkins: CheckinLine[]; moods: MoodLine[]; morningLogged: boolean; eveningLogged: boolean };
  unsorted: Capture[];
  reminders: { undelivered: number };
  session: { complete: boolean };
  /** a cloud provider's first job waits for the owner's OK (ADR-81): who, and the warning */
  aiCloud?: { host: string; who: string; warning: string } | null;
}

/** A habit on one day (the calendar's marks, round-2 brief §4) */
export interface HabitDay {
  path: string;
  slug: string;
  title: string;
  kind: 'quit' | 'build';
  private: boolean;
  value: 'clean' | 'slip' | 'skip' | null;
}

export interface WeekDay {
  date: string;
  hijri: string;
  prayers: Record<string, string>;
  events: EventItem[];
  tasks: Task[];
  habits: HabitDay[];
}

export interface MonthDay {
  date: string;
  hijriDay: number;
  hijriMonth: string;
  events: number;
  tasks: number;
  done: number;
  habits: HabitDay[];
  /** what the day's popover lists (round-3 brief §2) */
  list?: { events: { id: string; time: string | null; text: string }[]; tasks: { id: string; title: string; done: boolean }[] };
}

export interface CalendarMonth {
  month: string;
  today: string;
  hijri: string;
  days: MonthDay[];
}

export interface CalendarDay {
  date: string;
  today: string;
  hijri: string;
  hijriDay: number;
  prayers: Record<'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha', string>;
  events: EventItem[];
  tasks: Task[];
  habits: (HabitDay & { schedule: string; streak: number })[];
  goals: { slug: string; title: string; kind: string; done: number; total: number }[];
  prev: string;
  next: string;
}

export interface Week {
  start: string;
  key: string;
  today: string;
  days: WeekDay[];
}
