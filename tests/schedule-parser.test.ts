import { describe, it, expect } from 'vitest';
import {
  parseIntervalExpression,
  isIntervalExpression,
  isCronPreset,
  cronPresetToExpression,
  formatIntervalMs,
} from '../packages/shared/src/schedule-parser.js';

describe('parseIntervalExpression', () => {
  it('parses "5m" to 300000ms', () => {
    expect(parseIntervalExpression('5m')).toBe(5 * 60 * 1000);
  });

  it('parses "30s" to 30000ms', () => {
    expect(parseIntervalExpression('30s')).toBe(30 * 1000);
  });

  it('parses "2h" to 7200000ms', () => {
    expect(parseIntervalExpression('2h')).toBe(2 * 60 * 60 * 1000);
  });

  it('parses "1h30m" compound duration', () => {
    expect(parseIntervalExpression('1h30m')).toBe(90 * 60 * 1000);
  });

  it('parses "@every 5m" prefix', () => {
    expect(parseIntervalExpression('@every 5m')).toBe(5 * 60 * 1000);
  });

  it('returns null for invalid input', () => {
    expect(parseIntervalExpression('hello')).toBeNull();
    expect(parseIntervalExpression('')).toBeNull();
    expect(parseIntervalExpression('0')).toBeNull();
  });

  it('isIntervalExpression returns true for valid', () => {
    expect(isIntervalExpression('5m')).toBe(true);
    expect(isIntervalExpression('@every 30s')).toBe(true);
    expect(isIntervalExpression('not-valid')).toBe(false);
  });
});

describe('cron presets', () => {
  it('recognizes @daily', () => {
    expect(isCronPreset('@daily')).toBe(true);
    expect(cronPresetToExpression('@daily')).toBe('0 0 * * *');
  });

  it('recognizes @hourly', () => {
    expect(isCronPreset('@hourly')).toBe(true);
    expect(cronPresetToExpression('@hourly')).toBe('0 * * * *');
  });

  it('rejects non-presets', () => {
    expect(isCronPreset('5m')).toBe(false);
    expect(cronPresetToExpression('5m')).toBeNull();
  });
});

describe('formatIntervalMs', () => {
  it('formats seconds', () => {
    expect(formatIntervalMs(30000)).toBe('30s');
  });

  it('formats minutes', () => {
    expect(formatIntervalMs(300000)).toBe('5m');
  });

  it('formats hours', () => {
    expect(formatIntervalMs(7200000)).toBe('2h');
  });
});
