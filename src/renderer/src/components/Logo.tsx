/** The app mark, kept in sync with build/icon.ico and resources/logo.svg. */
export default function Logo({ size = 32 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="prcy-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6f6bff" />
          <stop offset="1" stopColor="#b05cf5" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#prcy-mark)" />
      <path
        d="M102 76 L102 164 L176 120 Z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="18"
        strokeLinejoin="round"
      />
      <rect x="84" y="182" width="88" height="16" rx="8" fill="#fff" opacity="0.86" />
    </svg>
  )
}
