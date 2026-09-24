import { stripInvisible } from '../text/normalize.ts';

export interface ChunkOptions {
  /** Target maximum chunk size in characters (~4 characters per token). */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next. */
  overlapChars?: number;
}

export interface TextChunk {
  index: number;
  content: string;
  /** Headings in force where the chunk starts, outermost first. */
  headings: string[];
  tokenEstimate: number;
}

/** ~500 tokens with ~60 tokens overlap (PLAN.md §4.7). */
const DEFAULT_MAX = 2_000;
const DEFAULT_OVERLAP = 240;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export function normalizeKnowledgeText(text: string): string {
  return stripInvisible(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLong(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const sentences = block.match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) ?? [block];
  const out: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (s.length > max) {
      if (current) out.push(current.trim());
      current = '';
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    if ((current + s).length > max && current) {
      out.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function tail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return chars <= 0 ? '' : text;
  const slice = text.slice(-chars);
  // Start the overlap at a sentence or word boundary when possible.
  const sentence = slice.search(/[.!?]\s+\S/);
  if (sentence >= 0 && sentence < chars / 2) return slice.slice(sentence + 1).trimStart();
  const space = slice.indexOf(' ');
  return space >= 0 ? slice.slice(space + 1) : slice;
}

/**
 * Splits knowledge-base text into overlapping chunks along paragraph and
 * sentence boundaries. Markdown headings ("# …") are tracked and repeated at
 * the top of each chunk so a chunk stays understandable on its own — which
 * matters both for retrieval and for the model citing it.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const max = opts.maxChars ?? DEFAULT_MAX;
  const overlap = Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.floor(max / 4));
  const blocks = normalizeKnowledgeText(text)
    .split(/\n{2,}/)
    .filter((b) => b.trim());

  const chunks: TextChunk[] = [];
  const headings: string[] = [];
  let body = '';
  let bodyHeadings: string[] = [];

  const flush = (carryOverlap: boolean) => {
    if (!body.trim()) return;
    const headingLine = bodyHeadings.length ? `${bodyHeadings.join(' › ')}\n\n` : '';
    const content = `${headingLine}${body.trim()}`;
    chunks.push({
      index: chunks.length,
      content,
      headings: bodyHeadings,
      tokenEstimate: Math.ceil(content.length / 4),
    });
    body = carryOverlap ? tail(body.trim(), overlap) : '';
    bodyHeadings = [...headings];
  };

  for (const block of blocks) {
    const firstLine = block.split('\n')[0]!;
    const h = HEADING_RE.exec(firstLine);
    if (h) {
      // A new section starts a new chunk (no overlap across sections).
      flush(false);
      const level = h[1]!.length;
      headings.splice(level - 1);
      headings[level - 1] = h[2]!.trim();
      bodyHeadings = headings.filter(Boolean);
      const rest = block.split('\n').slice(1).join('\n').trim();
      if (!rest) continue;
      for (const piece of splitLong(rest, max)) {
        if (body && (body + '\n\n' + piece).length > max) flush(true);
        body = body ? `${body}\n\n${piece}` : piece;
      }
      continue;
    }
    for (const piece of splitLong(block, max)) {
      if (body && (body + '\n\n' + piece).length > max) flush(true);
      if (!body) bodyHeadings = headings.filter(Boolean);
      body = body ? `${body}\n\n${piece}` : piece;
    }
  }
  flush(false);
  return chunks;
}
