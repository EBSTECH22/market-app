/**
 * The job being hired for, in one place — the public form, the server check,
 * the owner's email and the admin screen all read from here, so changing a
 * shift or the pay is one edit.
 */
export const JOB = {
  position: "Cashier",
  pay: "$11.00 per hour",
  type: "Part time",
  openings: 2,
};

export const SHIFTS = [
  { code: "WKDY", label: "Weekdays", detail: "Monday–Friday, 4:00–6:30 PM" },
  { code: "SAT_AM", label: "Saturday morning", detail: "8:00 AM–2:00 PM" },
  { code: "SAT_PM", label: "Saturday afternoon", detail: "12:30–6:30 PM" },
  { code: "SUN_AM", label: "Sunday morning", detail: "8:00 AM–2:00 PM" },
  { code: "SUN_PM", label: "Sunday afternoon", detail: "12:30–6:30 PM" },
] as const;

export const SHIFT_CODES: string[] = SHIFTS.map((s) => s.code);

/** "WKDY,SAT_AM" → "Weekdays 4–6:30, Saturday morning". Older day names pass through. */
export function shiftsLabel(stored: string): string {
  return stored
    .split(",")
    .filter(Boolean)
    .map((c) => {
      const s = SHIFTS.find((x) => x.code === c);
      return s ? `${s.label} (${s.detail})` : c;
    })
    .join(", ");
}
