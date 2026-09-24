import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

// Escaped string on purpose: formatters turn regex escapes into the invisible character.
const LEADING_BOM_RE = new RegExp('^\\uFEFF');

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type KbFileKind = 'pdf' | 'docx' | 'txt';

export const MIME_TYPES: Record<KbFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
};

export class UploadRejectedError extends Error {
  readonly reason: 'too_large' | 'empty' | 'unsupported_type' | 'not_utf8_text';

  constructor(reason: UploadRejectedError['reason']) {
    super(`upload rejected: ${reason}`);
    this.reason = reason;
    this.name = 'UploadRejectedError';
  }
}

function isZipWithWordDocument(bytes: Uint8Array): boolean {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04))
    return false;
  // The central directory lists "word/document.xml" for real DOCX files.
  return Buffer.from(bytes).includes('word/document.xml');
}

/**
 * Decides the file type from its bytes, not from the name or the browser's
 * Content-Type, and enforces the size limit (PDF, DOCX, TXT only).
 */
export function detectKbFile(bytes: Uint8Array): KbFileKind {
  if (bytes.length === 0) throw new UploadRejectedError('empty');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadRejectedError('too_large');
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') return 'pdf';
  if (isZipWithWordDocument(bytes)) return 'docx';
  if (bytes.includes(0)) throw new UploadRejectedError('unsupported_type');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UploadRejectedError('not_utf8_text');
  }
  return 'txt';
}

/** Safe object-name part: keeps letters, digits, dot, dash, underscore. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return cleaned || 'file';
}

export async function extractFileText(kind: KbFileKind, bytes: Uint8Array): Promise<string> {
  switch (kind) {
    case 'pdf': {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      return (Array.isArray(text) ? text : [text]).join('\n\n');
    }
    case 'docx': {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return value;
    }
    case 'txt':
      return new TextDecoder('utf-8').decode(bytes).replace(LEADING_BOM_RE, '');
  }
}
