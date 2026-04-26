export function LuminaLogo({ size = 32, dark = false }: { size?: number; dark?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Prism body */}
      <polygon points="18,5 31,28 5,28" fill={dark ? '#4A90E2' : '#4A90E2'} />
      {/* Inner face highlight */}
      <polygon points="18,10 27,26 9,26" fill="white" opacity="0.12" />
      {/* Entry ray */}
      <line x1="18" y1="1" x2="18" y2="5" stroke={dark ? 'white' : 'white'} strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="18" cy="1" r="1.2" fill={dark ? 'white' : 'white'} />
      {/* Refracted exit rays */}
      <line x1="5" y1="28" x2="2" y2="33" stroke="#00D4AA" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="18" y1="28" x2="18" y2="34" stroke="#93C5FD" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="31" y1="28" x2="34" y2="33" stroke="#A78BFA" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
