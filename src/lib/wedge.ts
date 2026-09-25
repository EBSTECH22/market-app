/**
 * Catching a barcode wherever it lands.
 *
 * A USB scanner is a keyboard, and a keyboard types into whatever happens to
 * have the cursor. Worse, most scanners finish with Tab or Enter, and Tab
 * moves the cursor to the NEXT field — so the code goes into the scan box and
 * the cursor leaves, and the following scan lands in the search box, or the
 * cash box, or nowhere at all.
 *
 * Watching one input can't solve that, because by the time the second scan
 * arrives the input isn't watching. So this watches the whole page instead: it
 * collects keystrokes as they happen, anywhere, and decides afterwards whether
 * what just arrived was a person typing or a machine.
 *
 * The test is speed, and it is not close. A scanner puts characters in a few
 * milliseconds apart; the quickest hands at a counter are twenty times slower.
 * Anything that fails the test is left alone entirely, so typing a cash amount
 * or a customer's email still behaves exactly as it always did.
 */

export type WedgeOptions = {
  /** Average ms per character below which no human is doing the typing. */
  gapMs?: number;
  /** Shorter than this isn't a barcode. */
  minLength?: number;
  /** A character arriving later than this starts a new code. */
  breakMs?: number;
};

export class WedgeBuffer {
  private chars: string[] = [];
  private startAt = 0;
  private lastAt = 0;
  private readonly gapMs: number;
  private readonly minLength: number;
  private readonly breakMs: number;

  constructor(opts: WedgeOptions = {}) {
    this.gapMs = opts.gapMs ?? 60;
    this.minLength = opts.minLength ?? 4;
    this.breakMs = opts.breakMs ?? 300;
  }

  reset(): void {
    this.chars = [];
    this.startAt = 0;
    this.lastAt = 0;
  }

  /** One printable character, as it was typed. */
  push(ch: string, now: number): void {
    /* A long silence means whatever came before was a different code, or
       somebody's hands. Either way it is not part of this one. */
    if (this.chars.length && now - this.lastAt > this.breakMs) this.reset();
    if (this.chars.length === 0) this.startAt = now;
    this.chars.push(ch);
    this.lastAt = now;
    /* A barcode is not a novel. Anything this long is a stuck key or somebody
       leaning on the counter. */
    if (this.chars.length > 64) this.reset();
  }

  /** What's buffered, if it reads like a machine put it there. */
  private qualified(): string | null {
    const code = this.chars.join("").trim();
    if (code.length < this.minLength) return null;
    const per = this.chars.length > 1 ? (this.lastAt - this.startAt) / (this.chars.length - 1) : 0;
    return per <= this.gapMs ? code : null;
  }

  /**
   * The scanner pressed its finishing key — Enter or Tab.
   *
   * Returns the code when the burst qualifies, and nothing when a person just
   * pressed Enter, which must go on behaving like Enter.
   */
  terminate(): string | null {
    const code = this.qualified();
    this.reset();
    return code;
  }

  /**
   * Nothing has arrived for a while.
   *
   * For scanners set to send no finishing key at all: the code is simply
   * complete once it stops growing.
   */
  settle(now: number, idleMs = 140): string | null {
    if (!this.chars.length || now - this.lastAt < idleMs) return null;
    return this.terminate();
  }

  get length(): number {
    return this.chars.length;
  }
}

/** Keys that mean "that's the whole code" on one scanner or another. */
export const isTerminator = (key: string): boolean =>
  key === "Enter" || key === "Tab" || key === "NumpadEnter";

/**
 * Is this keystroke one character of a barcode?
 *
 * Modifier combinations are somebody using the tablet, not a scanner, and a
 * named key like "Shift" or "ArrowLeft" is never part of a code.
 */
export const isBarcodeChar = (key: string, ctrl: boolean, meta: boolean, alt: boolean): boolean =>
  key.length === 1 && !ctrl && !meta && !alt;
