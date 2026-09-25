/**
 * The Noctiv lockup from the brand kit (packages/brand; copied to
 * public/brand by `pnpm --filter @noctiv/brand export`). Keep it 24 px tall
 * or more: below that the brand rules call for the small mark instead.
 */
const RATIO = 446.08 / 111.6;

export function Logo({ height = 26, className }: { height?: number; className?: string }) {
  return (
    // A static SVG from /public: next/image adds nothing here.
    <img
      src="/brand/horizontal-on-light.svg"
      alt="Noctiv"
      width={Math.round(height * RATIO)}
      height={height}
      className={className}
      style={{ height, width: 'auto' }}
    />
  );
}
