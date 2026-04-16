import { describe, it, expect } from 'vitest';
import { parseAskFounder } from '../packages/tui/src/components/ask-founder.js';

describe('parseAskFounder', () => {
  it('parses a basic choice question', () => {
    const content = `Some text <askFounder><question>Which DB?</question><answers><answer value="pg">Postgres</answer><answer value="sqlite">SQLite</answer></answers></askFounder> more text`;
    const { cleanContent, questions } = parseAskFounder(content, 'msg-1');
    expect(cleanContent).toBe('Some text  more text');
    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toBe('Which DB?');
    expect(questions[0]!.type).toBe('choice');
    expect(questions[0]!.answers).toHaveLength(2);
    expect(questions[0]!.answers[0]).toEqual({ value: 'pg', label: 'Postgres', description: undefined, preview: undefined });
  });

  it('parses description attribute', () => {
    const content = `<askFounder><question>Q</question><answers><answer value="a" description="desc A">A</answer></answers></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-2');
    expect(questions[0]!.answers[0]!.description).toBe('desc A');
  });

  it('parses preview attribute', () => {
    const content = `<askFounder><question>Q</question><answers><answer value="a" description="d" preview="CREATE TABLE x">A</answer></answers></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-3');
    expect(questions[0]!.answers[0]!.preview).toBe('CREATE TABLE x');
  });

  it('parses score type with min/max', () => {
    const content = `<askFounder type="score" min="1" max="5"><question>Rate quality</question></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-4');
    expect(questions[0]!.type).toBe('score');
    expect(questions[0]!.min).toBe(1);
    expect(questions[0]!.max).toBe(5);
    expect(questions[0]!.answers).toHaveLength(0);
  });

  it('defaults score to 0-10 when min/max omitted', () => {
    const content = `<askFounder type="score"><question>Trust?</question></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-5');
    expect(questions[0]!.min).toBe(0);
    expect(questions[0]!.max).toBe(10);
  });

  it('parses multi type', () => {
    const content = `<askFounder type="multi"><question>Features?</question><answers><answer value="a">A</answer><answer value="b">B</answer></answers></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-6');
    expect(questions[0]!.type).toBe('multi');
  });

  it('handles batched questions (multiple blocks)', () => {
    const content = `<askFounder><question>Q1</question><answers><answer value="a">A</answer></answers></askFounder> middle <askFounder type="score"><question>Q2</question></askFounder>`;
    const { cleanContent, questions } = parseAskFounder(content, 'msg-7');
    expect(questions).toHaveLength(2);
    expect(questions[0]!.question).toBe('Q1');
    expect(questions[0]!.index).toBe(0);
    expect(questions[1]!.question).toBe('Q2');
    expect(questions[1]!.index).toBe(1);
    expect(cleanContent).toBe('middle');
  });

  it('handles open question (no answers block)', () => {
    const content = `<askFounder><question>What do you think?</question></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-8');
    expect(questions[0]!.answers).toHaveLength(0);
    expect(questions[0]!.type).toBe('choice');
  });

  it('returns empty questions for content without askFounder tags', () => {
    const { cleanContent, questions } = parseAskFounder('Just normal text', 'msg-9');
    expect(cleanContent).toBe('Just normal text');
    expect(questions).toHaveLength(0);
  });

  it('skips malformed blocks with no question tag', () => {
    const content = `<askFounder><answers><answer value="a">A</answer></answers></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-10');
    expect(questions).toHaveLength(0);
  });

  it('preview newlines are decoded', () => {
    const content = `<askFounder><question>Q</question><answers><answer value="a" preview="line1\\nline2">A</answer></answers></askFounder>`;
    const { questions } = parseAskFounder(content, 'msg-11');
    expect(questions[0]!.answers[0]!.preview).toBe('line1\nline2');
  });
});
