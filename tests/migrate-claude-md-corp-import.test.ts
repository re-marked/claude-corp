/**
 * Tests for the surgical-insert helper used by the daemon-boot
 * migration that backfills `@./CORP.md` into existing CLAUDE.md
 * files.
 *
 * Filesystem-coupled walker (`migrateClaudeMdForCorpImport`) is left
 * untested — covered manually by Mark's e2e + the daemon log output.
 * The pure splice (`insertCorpManualSection`) is what's risky: it
 * touches user content, so the anchor priority + end-append fallback
 * deserve unit coverage.
 */
import { describe, it, expect } from 'vitest';
import { insertCorpManualSection } from '../packages/shared/src/migrate-claude-md-corp-import.js';

const SECTION_MARKER = '## The corp manual';
const IMPORT_LINE = '@./CORP.md';

describe('insertCorpManualSection — anchor insert', () => {
  it('inserts before "## Your live operational state" when present', () => {
    const existing = [
      '# CEO',
      '',
      'You are CEO, a CEO (partner) in my-corporation.',
      '',
      '## Survival protocol',
      '',
      'Run cc-cli wtf when disoriented.',
      '',
      '## Your live operational state',
      '',
      '@./STATUS.md',
      '@./TASKS.md',
      '',
    ].join('\n');

    const { content, insertedAt } = insertCorpManualSection(existing);

    expect(insertedAt).toBe('anchor');
    expect(content).toContain(SECTION_MARKER);
    expect(content).toContain(IMPORT_LINE);
    // Section appears BEFORE the live-state heading.
    expect(content.indexOf(SECTION_MARKER)).toBeLessThan(
      content.indexOf('## Your live operational state'),
    );
    // Original headings + content are preserved verbatim.
    expect(content).toContain('## Survival protocol');
    expect(content).toContain('@./STATUS.md');
    expect(content).toContain('@./TASKS.md');
  });

  it('falls back to "## Your inbox" anchor when live-state heading is gone', () => {
    const existing = [
      '# Custom CEO',
      '',
      '## Your inbox',
      '',
      'Inbox stuff.',
      '',
    ].join('\n');

    const { content, insertedAt } = insertCorpManualSection(existing);

    expect(insertedAt).toBe('anchor');
    expect(content.indexOf(SECTION_MARKER)).toBeLessThan(
      content.indexOf('## Your inbox'),
    );
  });

  it('higher-priority anchor wins when multiple are present', () => {
    const existing = [
      '## Your inbox',
      '',
      'inbox',
      '',
      '## Your live operational state',
      '',
      'state',
      '',
    ].join('\n');

    const { content } = insertCorpManualSection(existing);

    // Inserted at the FIRST anchor in source order — '## Your inbox'
    // appears earlier in this content even though it's lower priority.
    // The contract is "first matching anchor in priority order"; since
    // priority 1 ('live operational state') matches, it wins regardless
    // of position. Verify that.
    const sectionIdx = content.indexOf(SECTION_MARKER);
    const inboxIdx = content.indexOf('## Your inbox');
    const stateIdx = content.indexOf('## Your live operational state');
    expect(sectionIdx).toBeLessThan(stateIdx);
    expect(sectionIdx).toBeGreaterThan(inboxIdx); // inserted between inbox and state
  });
});

describe('insertCorpManualSection — end-append fallback', () => {
  it('appends to end when no anchor matches (hand-written CLAUDE.md)', () => {
    const existing = [
      '# Some custom file',
      '',
      'Nothing template-shaped here.',
      '',
      '## A heading the migration does not know about',
      '',
      'Custom content.',
      '',
    ].join('\n');

    const { content, insertedAt } = insertCorpManualSection(existing);

    expect(insertedAt).toBe('end');
    expect(content).toContain(SECTION_MARKER);
    expect(content).toContain(IMPORT_LINE);
    // Original content preserved at the front.
    expect(content.startsWith('# Some custom file')).toBe(true);
    // Section is at the end.
    expect(content.indexOf(SECTION_MARKER)).toBeGreaterThan(
      content.indexOf('Custom content.'),
    );
  });

  it('handles a file without trailing newline cleanly', () => {
    const existing = '# Bare\n\nLine without trailing newline'; // no \n at end

    const { content, insertedAt } = insertCorpManualSection(existing);

    expect(insertedAt).toBe('end');
    expect(content).toContain(SECTION_MARKER);
    // Should not run "Line without trailing newline## The corp manual" together.
    expect(content).not.toMatch(/newline## The corp manual/);
  });
});
