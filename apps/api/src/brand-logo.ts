import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * Uploaded logos (Settings → E-mail design, onboarding "Your brand"): PNG,
 * JPEG or SVG of at most 500 KB, stored as a PNG of at most 400 px. An SVG is
 * rendered to PNG here and never stored or served as SVG, so no script in it
 * can ever run; SVGs that reference anything outside themselves are refused.
 */
export const MAX_LOGO_BYTES = 500 * 1024;
export const LOGO_MAX_PX = 400;

export type LogoType = 'png' | 'jpeg' | 'svg';

export interface ProcessedLogo {
  png: Buffer;
  width: number;
  height: number;
  sourceType: LogoType;
  sha256: string;
}

export class LogoError extends Error {}

/** The file's type from its bytes (not its name or declared type). */
export function detectLogoType(b: Buffer): LogoType | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  const head = b
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head))
    return 'svg';
  return null;
}

/** Why an SVG is refused, or null: scripts, event handlers, entities, anything external. */
export function unsafeSvg(svg: string): string | null {
  if (/<!ENTITY/i.test(svg)) return 'entities';
  if (/<script[\s>]/i.test(svg)) return 'script';
  if (/<foreignObject[\s>]/i.test(svg)) return 'foreignObject';
  if (/\son[a-z]+\s*=/i.test(svg)) return 'event handler';
  // Links and images may only point inside the file (#id) or be embedded images.
  for (const m of svg.matchAll(/\s(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    const v = m[2]!.trim();
    if (!v.startsWith('#') && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(v))
      return 'external reference';
  }
  if (/url\(\s*["']?(?!#)/i.test(svg)) return 'external reference';
  if (/@import/i.test(svg)) return 'external reference';
  return null;
}

export async function processLogo(input: Buffer): Promise<ProcessedLogo> {
  if (input.length > MAX_LOGO_BYTES)
    throw new LogoError('The logo is larger than 500 KB. Use a smaller file.');
  const type = detectLogoType(input);
  if (!type) throw new LogoError('Use a PNG, JPG or SVG file.');
  let img: sharp.Sharp;
  try {
    if (type === 'svg') {
      const bad = unsafeSvg(input.toString('utf8'));
      if (bad) throw new LogoError(`This SVG cannot be used (${bad}). Export it as PNG instead.`);
      // Render a vector logo sharp at 400 px: pick the density from its own size.
      const meta = await sharp(input, { limitInputPixels: 25_000_000 }).metadata();
      const longest = Math.max(meta.width ?? 0, meta.height ?? 0) || 100;
      const density = Math.min(2400, Math.max(1, Math.ceil((72 * LOGO_MAX_PX) / longest)));
      img = sharp(input, { density, limitInputPixels: 25_000_000 });
    } else {
      img = sharp(input, { limitInputPixels: 25_000_000 }).rotate();
    }
    const out = await img
      .resize(LOGO_MAX_PX, LOGO_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return {
      png: out.data,
      width: out.info.width,
      height: out.info.height,
      sourceType: type,
      sha256: createHash('sha256').update(out.data).digest('hex'),
    };
  } catch (e) {
    if (e instanceof LogoError) throw e;
    throw new LogoError('This image could not be read. Try another file (PNG, JPG or SVG).');
  }
}

export const logoDataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
