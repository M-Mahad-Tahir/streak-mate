import { describe, expect, it } from 'vitest';
import { addDays, dateKeyIn, monthRange, weekday } from './dates';
import { normalizeClassCode, passwordStrength, validateClassCode, validateEmail, validatePassword, validateTask } from './validation';
import { BADGES, encouragement, nextBadge } from './streak';
import { friendlyError } from './api';

describe('dates', () => {
  it('computes the calendar date in a given timezone', () => {
    const instant = new Date('2026-03-01T22:30:00Z');
    expect(dateKeyIn(instant, 'UTC')).toBe('2026-03-01');
    expect(dateKeyIn(instant, 'Asia/Karachi')).toBe('2026-03-02'); // UTC+5
    expect(dateKeyIn(instant, 'America/Los_Angeles')).toBe('2026-03-01');
  });
  it('adds days across month and leap boundaries', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('returns month ranges and weekdays', () => {
    expect(monthRange('2026-02-14')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(weekday('2026-10-22')).toBe(4); // Thursday
  });
});

describe('validation', () => {
  it('validates email', () => {
    expect(validateEmail('')).toBeTruthy();
    expect(validateEmail('nope')).toBeTruthy();
    expect(validateEmail('a@b.co')).toBeNull();
  });
  it('validates password rules and strength', () => {
    expect(validatePassword('short1')).toMatch(/8 characters/);
    expect(validatePassword('longpassword')).toMatch(/letter and one number/);
    expect(validatePassword('longpass1')).toBeNull();
    expect(passwordStrength('Abcdefgh1234!').score).toBe(4);
  });
  it('validates tasks', () => {
    expect(validateTask({ title: '', description: '', due_date: '', due_time: '' })).toMatchObject({
      title: expect.any(String), due_date: expect.any(String), due_time: expect.any(String),
    });
    expect(validateTask({ title: 'Read', description: '', due_date: '2026-10-22', due_time: '18:00' })).toEqual({});
  });
  it('normalizes class codes', () => {
    expect(normalizeClassCode(' ab-12 cd34 ')).toBe('AB12CD34');
    expect(validateClassCode('abc')).toBeTruthy();
    expect(validateClassCode('7f3a9c21')).toBeNull();
  });
});

describe('streak presentation', () => {
  it('matches the database badge codes', () => {
    expect(BADGES.map((b) => b.code)).toEqual(['streak_3', 'streak_7', 'streak_14', 'streak_30', 'streak_50', 'streak_100']);
  });
  it('finds the next badge', () => {
    expect(nextBadge(0)?.days).toBe(3);
    expect(nextBadge(7)?.days).toBe(14);
    expect(nextBadge(100)).toBeNull();
  });
  it('encourages appropriately', () => {
    expect(encouragement(0, false)).toMatch(/start/);
    expect(encouragement(5, false)).toMatch(/keep it alive/);
  });
});

describe('friendlyError', () => {
  it('maps database errors to readable messages', () => {
    expect(friendlyError({ message: 'permission denied for table tasks', code: '42501' })).toMatch(/permission/);
    expect(friendlyError({ message: 'Failed to fetch' })).toMatch(/Network/);
    expect(friendlyError({ message: 'This task is already waiting for review.', code: '23505' })).toBe('This task is already waiting for review.');
  });
});
