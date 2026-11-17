// Where an image has something to look at: a cheap, cached read of a 24×N thumbnail on a canvas. A tall screenshot is
// shown cropped; this picks the busiest window instead of its (often empty) top, and says when the whole image is flat.
const cache = new Map<string, { flat: boolean; at: number }>()

/** Spread of the luminance of a slice of rows: 0 for a flat colour. */
function spread(px: Uint8ClampedArray, w: number, y0: number, y1: number): number {
  let n = 0, sum = 0, sq = 0
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    n++; sum += l; sq += l * l
  }
  return n ? Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) : 0
}

/** flat: under this spread the image (or window) reads as one colour. */
export const FLAT = 9

/** busiest window (0..100 % for object-position) of a `share`-tall crop, and whether the whole image is flat. */
export function busyOf(img: HTMLImageElement, share = 0.4): { flat: boolean; at: number } {
  const hit = cache.get(img.src)
  if (hit) return hit
  let out = { flat: false, at: 0 }
  try {
    const w = 24, h = Math.max(8, Math.round((24 * img.naturalHeight) / Math.max(1, img.naturalWidth)))
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })
    if (!g) return out
    g.drawImage(img, 0, 0, w, h)
    const px = g.getImageData(0, 0, w, h).data
    const win = Math.max(2, Math.round(h * share))
    let best = -1, at = 0
    for (let k = 0; k <= 8; k++) {
      const y0 = Math.round(((h - win) * k) / 8)
      const s = spread(px, w, y0, y0 + win)
      if (s > best + 2) { best = s; at = h > win ? (y0 / (h - win)) * 100 : 0 }
    }
    out = { flat: spread(px, w, 0, h) < FLAT, at: Math.round(at) }
  } catch {
    /* tainted or no canvas: show it as it is */
  }
  cache.set(img.src, out)
  return out
}
