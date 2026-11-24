import * as React from 'react'

export function BrandMark({ className }: { className?: string }) {
  const id = React.useId().replace(/:/g, '')
  const tube = `${id}-tube`
  const curve = `${id}-curve`
  const bead = `${id}-bead`
  return (
    <svg
      viewBox="0 0 400 480"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id={tube}
          gradientUnits="userSpaceOnUse"
          x1="88"
          y1="0"
          x2="152"
          y2="0"
        >
          <stop offset="0" stopColor="var(--brand)" stopOpacity=".6" />
          <stop offset=".35" stopColor="var(--brand)" />
          <stop offset=".62" stopColor="var(--brand)" />
          <stop offset="1" stopColor="#000" stopOpacity=".9" />
        </linearGradient>
        <linearGradient
          id={curve}
          gradientUnits="userSpaceOnUse"
          x1="88"
          y1="0"
          x2="322"
          y2="0"
        >
          <stop offset="0" stopColor="var(--brand)" stopOpacity=".6" />
          <stop offset=".35" stopColor="var(--brand)" />
          <stop offset=".62" stopColor="var(--brand)" />
          <stop offset="1" stopColor="#000" stopOpacity=".9" />
        </linearGradient>
        <radialGradient id={bead} cx=".35" cy=".3" r=".75">
          <stop offset="0" stopColor="#dfe6ff" />
          <stop
            offset=".2"
            stopColor="color-mix(in oklch, var(--brand) 75%, white)"
          />
          <stop offset=".75" stopColor="var(--brand)" />
          <stop offset="1" stopColor="#050a26" />
        </radialGradient>
      </defs>
      <g fill="none" strokeLinecap="round">
        <path
          d="M120 70 V410"
          stroke="#000"
          strokeOpacity=".35"
          strokeWidth="64"
          transform="translate(10 12)"
        />
        <path
          d="M290 110 C290 250 120 230 120 330"
          stroke="#000"
          strokeOpacity=".35"
          strokeWidth="64"
          transform="translate(10 12)"
        />
        <path d="M120 70 V410" stroke={`url(#${tube})`} strokeWidth="64" />
        <path
          d="M290 110 C290 250 120 230 120 330"
          stroke={`url(#${curve})`}
          strokeWidth="64"
        />
        <path
          d="M108 80 V400"
          stroke="#fff"
          strokeOpacity=".32"
          strokeWidth="8"
        />
        <path
          d="M278 120 C278 240 108 222 108 320"
          stroke="#fff"
          strokeOpacity=".26"
          strokeWidth="7"
        />
      </g>
      <circle cx="120" cy="70" r="58" fill={`url(#${bead})`} />
      <circle cx="290" cy="110" r="58" fill={`url(#${bead})`} />
      <circle cx="120" cy="410" r="58" fill={`url(#${bead})`} />
      <ellipse cx="102" cy="48" rx="18" ry="11" fill="#fff" opacity=".5" />
      <ellipse cx="272" cy="88" rx="18" ry="11" fill="#fff" opacity=".5" />
      <ellipse cx="102" cy="388" rx="18" ry="11" fill="#fff" opacity=".5" />
    </svg>
  )
}
