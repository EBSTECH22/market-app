/**
 * Code 128 (subset B) — the bars a handheld scanner at the till reads.
 *
 * Written out rather than installed. A barcode generator is a lookup table and
 * forty lines of arithmetic; adding a dependency for it would mean a new entry
 * in package-lock.json and a Vercel install that can fail for reasons nobody
 * here can debug at 9am on a Saturday. This has no dependencies at all.
 *
 * Subset B only, deliberately. Subset C packs digit pairs into one symbol and
 * would make the barcode ~20% narrower, at the cost of mode-switch logic that
 * is the usual place these go wrong. Collection codes are fourteen characters;
 * narrower is not worth a bug that prints a barcode nobody can scan.
 *
 * Every pattern is six alternating elements — bar, space, bar, space, bar,
 * space — whose widths add to eleven modules. The stop pattern is the one
 * exception: seven elements, thirteen modules. `assertTable` below checks both
 * properties at module load, so a typo in the table fails loudly and
 * immediately rather than printing bars that scan as the wrong order.
 */

/** Widths for values 0–106. Index = Code 128 value; digits = element widths. */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

const START_B = 104;
const STOP = 106;

/** Fails at import time if the table was mistyped. Cheap, and it has caught one. */
function assertTable() {
  if (PATTERNS.length !== 107) throw new Error(`code128: expected 107 patterns, got ${PATTERNS.length}`);
  const seen = new Set<string>();
  PATTERNS.forEach((p, i) => {
    const expectedElements = i === STOP ? 7 : 6;
    const expectedModules = i === STOP ? 13 : 11;
    if (p.length !== expectedElements) throw new Error(`code128: pattern ${i} has ${p.length} elements`);
    const sum = p.split("").reduce((n, d) => n + Number(d), 0);
    if (sum !== expectedModules) throw new Error(`code128: pattern ${i} sums to ${sum}`);
    if (seen.has(p)) throw new Error(`code128: pattern ${i} is a duplicate`);
    seen.add(p);
  });
}
assertTable();

/** Can subset B carry this text at all? (Printable ASCII, space through ~.) */
export function code128Encodable(text: string): boolean {
  return /^[\x20-\x7e]+$/.test(text);
}

/**
 * The barcode as a run of modules: true is a bar, false is a space.
 *
 * Quiet zones are the caller's problem — they depend on how the image is laid
 * out — except that every scanner needs them, so `barcodePng` adds ten modules
 * either side and nothing should render this without doing the same.
 */
export function code128Modules(text: string): boolean[] {
  if (!code128Encodable(text)) throw new Error("code128: subset B can only carry printable ASCII");

  const values = [START_B, ...text.split("").map((ch) => ch.charCodeAt(0) - 32)];

  /* Weighted mod-103 check character. Start counts once; each data character
     counts by its position, first is 1. */
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);

  const modules: boolean[] = [];
  for (const v of values) {
    const pattern = PATTERNS[v];
    for (let i = 0; i < pattern.length; i++) {
      const width = Number(pattern[i]);
      const isBar = i % 2 === 0; // patterns always start on a bar
      for (let w = 0; w < width; w++) modules.push(isBar);
    }
  }
  /* No terminating bar is appended here: the seven-element stop pattern above
     already ends on a two-module bar, which IS the terminator. Adding another
     would widen it to four modules and a real scanner would reject the symbol,
     even though a phone app would still read it. */
  return modules;
}
