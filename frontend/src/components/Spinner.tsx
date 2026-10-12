// Canonical loading spinner — replaces the identical `@keyframes ... rotate(360deg)`
// block that used to be hand-duplicated (under different names) across several
// inline-style files. Self-contained (renders its own keyframe), so it works
// identically whether the importing file otherwise uses Tailwind classes or
// inline styles.
export function Spinner({ size = 16, color = '#0C0D0D', trackColor = '#E5E5EA' }: {
  size?: number;
  color?: string;
  trackColor?: string;
}) {
  return (
    <>
      <span style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        border: `2px solid ${trackColor}`, borderTopColor: color,
        animation: 'lumina-spin 0.7s linear infinite', flexShrink: 0,
      }} />
      <style>{'@keyframes lumina-spin{to{transform:rotate(360deg)}}'}</style>
    </>
  );
}
