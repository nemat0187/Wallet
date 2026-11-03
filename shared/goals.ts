// Savings goals: progress and the monthly amount that would reach the target by the deadline.

import { daysBetween } from "./money";

export interface Goal {
  id: number;
  name: string;
  target: number; // minor units
  saved: number;
  deadline: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalProgress {
  pct: number; // 0..100
  remaining: number;
  done: boolean;
  /** Days to the deadline (negative once passed), or null without a deadline. */
  days_left: number | null;
  /** Per month needed to finish on time; null without a deadline, when done, or when the deadline has passed. */
  monthly: number | null;
}

export function goalProgress(g: Pick<Goal, "target" | "saved" | "deadline">, today: string): GoalProgress {
  const remaining = Math.max(0, g.target - g.saved);
  const done = remaining === 0;
  const daysLeft = g.deadline ? daysBetween(today, g.deadline) : null;
  const months = daysLeft !== null && daysLeft > 0 ? Math.max(1, daysLeft / 30.44) : null;
  return {
    pct: Math.min(100, Math.floor((g.saved / g.target) * 100)),
    remaining,
    done,
    days_left: daysLeft,
    monthly: done || months === null ? null : Math.ceil(remaining / months),
  };
}
