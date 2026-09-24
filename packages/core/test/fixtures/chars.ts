/**
 * Invisible characters for tests, built from code points so that no source
 * file ever contains them literally (formatters turn "\u…" escapes into the
 * characters themselves).
 */
export const ZWSP = String.fromCodePoint(0x200b); // zero-width space
export const ZWJ = String.fromCodePoint(0x200d); // zero-width joiner
export const RLO = String.fromCodePoint(0x202e); // right-to-left override
export const BOM = String.fromCodePoint(0xfeff); // byte-order mark / zero-width no-break space
export const NBSP = String.fromCodePoint(0x00a0); // no-break space

export const INVISIBLE_RE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]');
