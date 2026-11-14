/** Streak presentation helpers (the streak itself is always computed by the database). */

export interface BadgeDef {
  code: string;
  days: number;
  label: string;
  emoji: string;
}

export const BADGES: BadgeDef[] = [
  { code: 'streak_3', days: 3, label: 'Spark', emoji: '✨' },
  { code: 'streak_7', days: 7, label: 'On Fire', emoji: '🔥' },
  { code: 'streak_14', days: 14, label: 'Unstoppable', emoji: '⚡' },
  { code: 'streak_30', days: 30, label: 'Monthly Master', emoji: '🏆' },
  { code: 'streak_50', days: 50, label: 'Legend', emoji: '👑' },
  { code: 'streak_100', days: 100, label: 'Centurion', emoji: '💎' },
];

export function nextBadge(longest: number): BadgeDef | null {
  return BADGES.find((b) => b.days > longest) ?? null;
}

export function encouragement(current: number, wonToday: boolean): string {
  if (current === 0) return 'Complete your tasks today to start a new streak!';
  if (!wonToday) return `You're on a ${current}-day streak. Finish today's tasks to keep it alive!`;
  if (current >= 30) return 'Incredible discipline. You are a consistency legend!';
  if (current >= 14) return 'Two weeks and counting. Keep the momentum going!';
  if (current >= 7) return 'A full week of wins. Amazing work!';
  if (current >= 3) return "You're building a real habit. Keep it up!";
  return "Great start! Come back tomorrow to grow your streak.";
}

export const STREAK_RULE =
  'A day counts as a Win Day when you complete at least one task that day (in your timezone) ' +
  'and every task due that day was completed on or before its due date. ' +
  'Your current streak is the number of Win Days in a row ending today, or yesterday if today is still in progress. ' +
  'Rejected work stops counting until you redo it.';
