/**
 * Catching a barcode on an Android tablet, where none of the obvious things work.
 *
 * What a real scan looks like, captured from the market's own scanner on the
 * market's own tablet:
 *
 *     Shift        ShiftLeft      16   0ms    (uppercase coming)
 *     Unidentified                229  10ms   <- the "V"
 *     0            Digit0         48   16ms
 *     1            Digit1         49   44ms
 *     Unidentified                229  14ms   <- the "-"
 *     0            Digit0         48   5ms
 *     0            Digit0         48   5ms
 *     0            Digit0         48   10ms
 *     1            Digit1         49   6ms
 *     ArrowDown    ArrowDown      40   27ms   <- the finishing key
 *
 * Two lessons, both of which cost a working till a day:
 *
 * ONE: THE CODE CANNOT BE READ FROM THE KEYSTROKES. Android puts some
 * characters through its input layer, which reports them as "Unidentified"
 * with keyCode 229 and no character at all. The scan above is V01-0001 and the
 * readable keys spell 010001. So the code is taken from the FIELD'S VALUE,
 * which is always right, and the keystrokes are used only for their timing.
 *
 * TWO: THE FINISHING KEY IS AN ARROW. Not Enter, not Tab — this scanner sends
 * a down arrow, and Android moves the cursor to the next field when it sees
 * one. That is why the first scan worked and every scan after it landed in the
 * search box: the cursor had been pushed out and nothing put it back.
 *
 * So: watch the timing of keystrokes to know a machine is typing, swallow the
 * finishing key so the cursor stays put, and read the code out of the field.
 */

export type WedgeOptions = {
  /** Average ms between keystrokes below which no human is doing the typing. */
  gapMs?: number;
  /** Fewer keystrokes than this isn't a barcode. */
  minKeys?: number;
  /** A keystroke later than this begins a new code. */
  breakMs?: number;
};

export class WedgeTiming {
  private count = 0;
  private startAt = 0;
  private lastAt = 0;
  private readonly gapMs: number;
  private readonly minKeys: number;
  private readonly breakMs: number;

  constructor(opts: WedgeOptions = {}) {
    this.gapMs = opts.gapMs ?? 60;
    this.minKeys = opts.minKeys ?? 4;
    this.breakMs = opts.breakMs ?? 300;
  }

  reset(): void {
    this.count = 0;
    this.startAt = 0;
    this.lastAt = 0;
  }

  /**
   * One keystroke, whatever it was.
   *
   * Deliberately NOT filtered by key name: the whole point is that some of a
   * scan's keystrokes have no usable name. What matters is that something
   * arrived, and when.
   */
  tick(now: number): void {
    if (this.count && now - this.lastAt > this.breakMs) this.reset();
    if (this.count === 0) this.startAt = now;
    this.count += 1;
    this.lastAt = now;
  }

  /** Does the run so far look like a machine rather than hands? */
  looksMachine(): boolean {
    if (this.count < this.minKeys) return false;
    const per = (this.lastAt - this.startAt) / (this.count - 1);
    return per <= this.gapMs;
  }

  /** Has a machine-speed run finished and gone quiet? */
  settled(now: number, idleMs = 160): boolean {
    return this.looksMachine() && this.count > 0 && now - this.lastAt >= idleMs;
  }

  get keys(): number {
    return this.count;
  }
}

/**
 * Keys a scanner might send to say "that's the whole code".
 *
 * The arrows are here because this market's scanner sends one, and because on
 * Android an arrow moves the cursor to the next field — which is the specific
 * thing that has to be stopped. They only ever count as a finishing key when a
 * machine-speed run is already in progress, so arrow keys still work normally
 * for anybody using the tablet by hand.
 */
export const isTerminator = (key: string): boolean =>
  key === "Enter" ||
  key === "Tab" ||
  key === "NumpadEnter" ||
  key === "ArrowDown" ||
  key === "ArrowUp" ||
  key === "ArrowRight";

/**
 * The code, taken from wherever the characters actually landed.
 *
 * The cursor may have been pushed into another field by a previous scan, so
 * the field holding the code is whichever one has it — the active one if it is
 * a text box with something in it, and the scan box otherwise.
 */
export function readCode(active: Element | null, fallback: HTMLInputElement | null): string {
  const el = active as HTMLInputElement | null;
  const isText =
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA") &&
    typeof el.value === "string";
  const fromActive = isText ? el.value.trim() : "";
  if (fromActive) return fromActive;
  return (fallback?.value || "").trim();
}
