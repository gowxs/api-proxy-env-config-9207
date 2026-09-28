/**
 * Brand colour rules shared by the brand block's check and previews. They
 * match what is sent (core email-design brandTextColor, quotes pdfBrandTextColor):
 * text in the brand colour on white needs 3:1 (large bold text), otherwise
 * the default navy is used.
 */
export const DEFAULT_BRAND = '#2F3A56';
export const INK = '#1F2430';

export const isHexColor = (c: string) => /^#[0-9A-Fa-f]{6}$/.test(c);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** The colour used for the company name and links on white. */
export const brandTextColor = (c: string) =>
  isHexColor(c) && contrast(c, '#FFFFFF') >= 3 ? c.toUpperCase() : DEFAULT_BRAND;

/** White or ink on the brand colour (buttons), whichever reads better. */
export const onBrand = (c: string) =>
  contrast('#FFFFFF', c) >= contrast(INK, c) ? '#FFFFFF' : INK;

/** Logo files the upload accepts (checked again by the server from the bytes). */
export const LOGO_ACCEPT = '.png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml';
export const LOGO_MAX_BYTES = 500 * 1024;
