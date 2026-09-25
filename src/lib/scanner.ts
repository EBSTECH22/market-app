/**
 * Telling a barcode scanner apart from a person typing.
 *
 * A USB scanner is a keyboard. It types the code and then, usually, presses
 * something to say it has finished — Enter on most, Tab on plenty, and on some
 * nothing whatsoever, depending on how it left the factory. A till that waits
 * only for Enter leaves those last ones typing the code into the box and
 * stopping, which looks for all the world like a broken scanner.
 *
 * The tell is speed. A scanner puts characters in a few milliseconds apart;
 * the quickest hands at a counter are an order of magnitude slower. So a run
 * of characters at machine speed, followed by silence, is a finished scan, and
 * can be looked up without anybody pressing anything.
 *
 * Kept out of the register page so it can be tested against timings rather
 * than against somebody standing there with a scanner.
 */

export type ScanBurstOptions = {
  /** Gap between characters below which no human is doing the typing. */
  gapMs?: number;
  /** How many machine-speed characters in a row before it counts. */
  needRun?: number;
  /** Shorter than this isn't a barcode, however fast it arrived. */
  minLength?: number;
};

export class ScanBurst {
  private lastAt = 0;
  private run = 0;
  private readonly gapMs: number;
  private readonly needRun: number;
  private readonly minLength: number;

  constructor(opts: ScanBurstOptions = {}) {
    this.gapMs = opts.gapMs ?? 45;
    this.needRun = opts.needRun ?? 3;
    this.minLength = opts.minLength ?? 4;
  }

  reset(): void {
    this.lastAt = 0;
    this.run = 0;
  }

  /**
   * Take one change to the box's contents.
   *
   * Returns true when what is in there now looks like a machine put it there,
   * which is the caller's cue to start its "has it stopped?" timer.
   */
  see(value: string, now: number): boolean {
    const gap = now - this.lastAt;
    this.lastAt = now;

    /* An almost-empty box means somebody has just cleared it or is starting
       over, and whatever came before tells us nothing about what comes next. */
    if (value.length < 2) this.run = 0;
    else if (gap <= this.gapMs) this.run += 1;
    else this.run = 0;

    return this.run >= this.needRun && value.trim().length >= this.minLength;
  }
}

/**
 * Does this read like a manufacturer's own barcode rather than one of ours?
 *
 * UPC-E is 8 digits, UPC-A 12, EAN-13 13, and the 14 is a case code. Nothing
 * this market prints is a bare run of digits that length, so a code that
 * matches came off a packet rather than off a shelf label — which is a
 * different problem from "that item doesn't exist", and worth saying.
 */
export const looksLikeProductBarcode = (code: string): boolean =>
  /^\d{8}$|^\d{12,14}$/.test(String(code).trim());
