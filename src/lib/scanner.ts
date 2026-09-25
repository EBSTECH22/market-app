/**
 * Telling a barcode scanner apart from a person typing.
 *
 * A USB scanner is a keyboard as far as the tablet is concerned: it types the
 * code and then, USUALLY, presses something to say it has finished — Enter on
 * most, Tab on plenty, and on some nothing whatsoever, depending on how it
 * left the factory. A till that waits only for Enter leaves those last ones
 * typing the code into the box and stopping.
 *
 * So the code is also taken on speed. Two different tells, because a scanner
 * shows up in two different shapes:
 *
 *   - CHARACTER BY CHARACTER, a few milliseconds apart. The quickest hands at
 *     a counter are an order of magnitude slower, so the average gap gives it
 *     away.
 *   - ALL AT ONCE, the whole code arriving in a single event because the
 *     browser coalesced a burst it couldn't keep up with. This is the common
 *     shape on a tablet, and it is the one an earlier version of this file
 *     missed completely: measuring the gaps between characters finds nothing
 *     when there is only ever one event.
 *
 * Either tell is enough. A person cannot produce three characters in one
 * event, and cannot average sixty milliseconds a character over a whole code.
 *
 * Kept out of the register page so it can be tested against timings rather
 * than against somebody standing there with a scanner.
 */

export type ScanBurstOptions = {
  /** Average ms per character below which no human is doing the typing. */
  gapMs?: number;
  /** Characters appearing in ONE event that hands could not have produced. */
  chunk?: number;
  /** Shorter than this isn't a barcode, however fast it arrived. */
  minLength?: number;
};

export class ScanBurst {
  private startAt = 0;
  private lastLen = 0;
  /** Characters seen arriving since the burst started — NOT the box's length. */
  private grown = 0;
  private machine = false;
  private readonly gapMs: number;
  private readonly chunk: number;
  private readonly minLength: number;

  constructor(opts: ScanBurstOptions = {}) {
    this.gapMs = opts.gapMs ?? 60;
    this.chunk = opts.chunk ?? 3;
    this.minLength = opts.minLength ?? 4;
  }

  reset(): void {
    this.startAt = 0;
    this.lastLen = 0;
    this.grown = 0;
    this.machine = false;
  }

  /**
   * Take one change to the box's contents.
   *
   * Returns true when what is in there now looks like a machine put it there,
   * which is the caller's cue to start its "has it stopped?" timer.
   */
  see(value: string, now: number): boolean {
    const len = value.length;
    const added = len - this.lastLen;

    /* Emptied. Whatever came before says nothing about what comes next. */
    if (len === 0) {
      this.reset();
      return false;
    }

    /* Backspacing — somebody correcting themselves, which settles the question
       of whether hands are involved. Start the clock again from here rather
       than resetting outright: the next character must not be mistaken for the
       first of a burst, which is how a correction used to fire a lookup. */
    if (added < 0) {
      this.startAt = now;
      this.grown = 0;
      this.machine = false;
      this.lastLen = len;
      return false;
    }

    if (this.lastLen === 0 && this.grown === 0) this.startAt = now;
    this.grown += added;

    /* Several characters in one go. Hands cannot do this; a scanner whose
       burst the browser coalesced into one event does it every time. */
    if (added >= this.chunk) this.machine = true;

    /* Or the characters arrived faster than hands could manage. Averaged over
       the burst rather than counted as a run, so one stalled event in the
       middle of a scan doesn't disqualify it. */
    const perChar = this.grown > 1 ? (now - this.startAt) / (this.grown - 1) : Number.POSITIVE_INFINITY;
    if (this.grown >= this.minLength && perChar <= this.gapMs) this.machine = true;

    this.lastLen = len;
    return this.machine && value.trim().length >= this.minLength;
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
