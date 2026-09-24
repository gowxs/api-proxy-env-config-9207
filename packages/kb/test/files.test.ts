import { describe, expect, it } from 'vitest';
import {
  detectKbFile,
  extractFileText,
  MAX_UPLOAD_BYTES,
  safeFileName,
  UploadRejectedError,
} from '../src/index.ts';
import { makeDocx, makePdf } from './helpers.ts';

describe('detectKbFile: type from bytes, not name', () => {
  it('recognises PDF, DOCX and UTF-8 text', async () => {
    expect(detectKbFile(await makePdf(['Candles cost 24 EUR.']))).toBe('pdf');
    expect(detectKbFile(await makeDocx('Prices', ['Candles cost 24 EUR.']))).toBe('docx');
    expect(
      detectKbFile(new TextEncoder().encode('Kerzen kosten 24 EUR. Piegāde 2-3 dienas.')),
    ).toBe('txt');
  });

  it.each([
    ['empty', new Uint8Array(0), 'empty'],
    ['too large', new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(65), 'too_large'],
    [
      'binary (PNG)',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
      'unsupported_type',
    ],
    [
      'plain zip, not a Word file',
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 0]),
      'unsupported_type',
    ],
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28, 0x41]), 'not_utf8_text'],
  ])('rejects %s', (_name, bytes, reason) => {
    expect(() => detectKbFile(bytes)).toThrow(UploadRejectedError);
    try {
      detectKbFile(bytes);
    } catch (e) {
      expect((e as UploadRejectedError).reason).toBe(reason);
    }
  });
});

describe('extractFileText', () => {
  it('reads text from a PDF', async () => {
    const text = await extractFileText(
      'pdf',
      await makePdf(['Nordlicht Candles price list', 'Soy candle: 24 EUR']),
    );
    expect(text).toContain('Nordlicht Candles price list');
    expect(text).toContain('24 EUR');
  });

  it('reads text from a DOCX', async () => {
    const text = await extractFileText(
      'docx',
      await makeDocx('Shipping', ['Latvia: 2-3 business days.', 'EU: 5 business days.']),
    );
    expect(text).toContain('Shipping');
    expect(text).toContain('EU: 5 business days.');
  });

  it('reads UTF-8 text and drops a byte-order mark', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Sveces 24 eiro')]);
    expect(await extractFileText('txt', bytes)).toBe('Sveces 24 eiro');
  });
});

describe('safeFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['Preisliste 2026 (neu).pdf', 'Preisliste_2026_neu_.pdf'],
    ['cenas_rādītājs.docx', 'cenas_raditajs.docx'],
    ['.env', 'env'],
    ['', 'file'],
  ])('%j → %j', (input, out) => {
    expect(safeFileName(input)).toBe(out);
  });
});
