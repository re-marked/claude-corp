import { PassThrough } from 'stream';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Stdin filter that intercepts bracketed paste sequences.
 *
 * Extends PassThrough (a real Node.js stream) so Ink gets a proper stream
 * interface with setEncoding, pipe, resume, pause — all working correctly.
 *
 * Paste content between \x1b[200~ and \x1b[201~ is buffered and emitted
 * as a 'paste' event. Everything else flows through to Ink normally.
 */
export class PasteFilterStdin extends PassThrough {
  isTTY = true;
  private pasteBuffer: string | null = null;

  constructor() {
    super({ encoding: 'utf-8' });
    process.stdin.on('data', this.handleData);
  }

  setRawMode(mode: boolean): this {
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(mode);
    }
    return this;
  }

  override resume(): this {
    process.stdin.resume();
    return super.resume();
  }

  override pause(): this {
    process.stdin.pause();
    return super.pause();
  }

  get fd(): number { return process.stdin.fd; }

  // Ink calls ref/unref to control event loop behavior
  ref(): this { process.stdin.ref(); return this; }
  unref(): this { process.stdin.unref(); return this; }

  override destroy(): this {
    process.stdin.off('data', this.handleData);
    return super.destroy();
  }

  private handleData = (chunk: Buffer | string): void => {
    const data = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    // Fast path: no escape sequences and not mid-paste → pass through
    if (this.pasteBuffer === null && !data.includes('\x1b[')) {
      this.push(data);
      return;
    }

    let remaining = data;

    while (remaining.length > 0) {
      if (this.pasteBuffer !== null) {
        // Currently buffering paste content — look for end marker
        const endIdx = remaining.indexOf(PASTE_END);
        if (endIdx !== -1) {
          this.pasteBuffer += remaining.slice(0, endIdx);
          this.emit('paste', this.pasteBuffer);
          this.pasteBuffer = null;
          remaining = remaining.slice(endIdx + PASTE_END.length);
        } else {
          this.pasteBuffer += remaining;
          remaining = '';
        }
      } else {
        // Normal mode — look for paste start marker
        const startIdx = remaining.indexOf(PASTE_START);
        if (startIdx !== -1) {
          if (startIdx > 0) {
            this.push(remaining.slice(0, startIdx));
          }
          this.pasteBuffer = '';
          remaining = remaining.slice(startIdx + PASTE_START.length);
        } else {
          this.push(remaining);
          remaining = '';
        }
      }
    }
  };
}

// Module-level singleton
let instance: PasteFilterStdin | null = null;

export function getPasteFilter(): PasteFilterStdin {
  if (!instance) {
    instance = new PasteFilterStdin();
  }
  return instance;
}

export function enableBracketedPaste(): void {
  process.stdout.write('\x1b[?2004h');
}

export function disableBracketedPaste(): void {
  process.stdout.write('\x1b[?2004l');
}
