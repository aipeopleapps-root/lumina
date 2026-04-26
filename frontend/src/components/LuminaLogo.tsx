export function LuminaLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* 4-pointed sparkle — the main mark */}
      <path
        d="M18 2 C17.4 11.6 12.6 16.6 2 18 C12.6 19.4 17.4 24.4 18 34 C18.6 24.4 23.4 19.4 34 18 C23.4 16.6 18.6 11.6 18 2Z"
        fill="white"
      />
      {/* Small accent dot — the "glint" of light */}
      <circle cx="27" cy="9" r="2.4" fill="white" opacity="0.55" />
    </svg>
  );
}
