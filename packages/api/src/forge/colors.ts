// A provider's label colour (any hex) as one of the colours labels have here.
import type { LabelColor } from '../domain/records'

export function labelColorOf(hex: string): LabelColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 'gray'
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const l = (max + min) / 2
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  // Greys, near-white and near-black read as no colour at all.
  if (sat < 0.2 || l > 0.93 || l < 0.08) return 'gray'
  let h =
    max === r
      ? ((g - b) / d) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4
  h = (h * 60 + 360) % 360
  if (h < 15 || h >= 335) return 'red'
  if (h < 42) return 'orange'
  if (h < 70) return 'yellow'
  if (h < 180) return 'green'
  if (h < 240) return 'blue'
  return 'purple'
}
