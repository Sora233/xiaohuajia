import { buildSpatialIndex, type Contour } from '@/lib/contours'
import {
  arcLength,
  dedupePoints,
  resampleSpacing,
  simplifyClosed,
  smoothPolyline,
  type Point,
} from '@/lib/polyline'

/** 细节 50 时的墨迹阈值，对应参考实现里的默认 threshold。 */
const THRESHOLD_AT_MID = 120
/** 小于等于这么多像素的墨点和孔洞丢掉。 */
const TURD_SIZE = 2

const N8X = [1, 1, 0, -1, -1, -1, 0, 1]
const N8Y = [0, 1, 1, 1, 0, -1, -1, -1]

/**
 * 灰度、把对比度拉满，再按阈值把深色收成墨块，沿边界描成闭合线。
 * 细节越高，阈值越高，越浅的颜色也会被当成墨。四角都很暗时，改描浅色区域，避免整张黑底变成一块。
 */
export function traceInkOutlines(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  detail: number,
): Contour[] {
  const n = width * height
  if (n === 0) return []
  const luma = new Float32Array(n)
  let lo = 255
  let hi = 0
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const y = rgba[i + 3] === 0 ? 255 : 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    luma[p] = y
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  const span = hi - lo
  if (span > 1) {
    for (let i = 0; i < n; i++) luma[i] = ((luma[i] - lo) / span) * 255
  }

  const tNorm = Math.min(100, Math.max(0, detail)) / 100
  // 细节越高，越浅的颜色也算墨。50 正好是阈值 120。
  const threshold = Math.round(THRESHOLD_AT_MID + (tNorm - 0.5) * 120)
  const invert = cornersAreDark(luma, width, height)
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const ink = invert ? luma[i] > threshold : luma[i] < threshold
    if (ink) mask[i] = 1
  }
  suppressSpeckles(mask, width, height, TURD_SIZE)
  fillTinyHoles(mask, width, height, TURD_SIZE)

  const raw = traceBoundaries(mask, width, height)
  const contours: Contour[] = []
  for (const loop of raw) {
    const points = polishLoop(loop)
    if (closedLength(points) < 4) continue
    contours.push({ id: contours.length, points, closed: true })
  }
  return contours
}

export function indexInkOutlines(contours: Contour[], width: number, height: number) {
  return buildSpatialIndex(contours, width, height)
}

function cornersAreDark(luma: Float32Array, width: number, height: number) {
  if (width < 2 || height < 2) return false
  const samples = [
    luma[0],
    luma[width - 1],
    luma[(height - 1) * width],
    luma[(height - 1) * width + width - 1],
  ]
  return samples.every((v) => v < 36)
}

function suppressSpeckles(mask: Uint8Array, width: number, height: number, turd: number) {
  const labels = new Int32Array(mask.length)
  const areas: number[] = []
  let id = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x
      if (!mask[start] || labels[start]) continue
      id++
      let area = 0
      const stack = [start]
      labels[start] = id
      while (stack.length) {
        const cur = stack.pop()!
        area++
        const cx = cur % width
        const cy = (cur - cx) / width
        for (let k = 0; k < 8; k++) {
          const nx = cx + N8X[k]
          const ny = cy + N8Y[k]
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const j = ny * width + nx
          if (!mask[j] || labels[j]) continue
          labels[j] = id
          stack.push(j)
        }
      }
      areas[id] = area
    }
  }
  for (let i = 0; i < mask.length; i++) {
    const label = labels[i]
    if (label && areas[label] <= turd) mask[i] = 0
  }
}

function fillTinyHoles(mask: Uint8Array, width: number, height: number, turd: number) {
  const seen = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x
      if (mask[start] || seen[start]) continue
      const stack = [start]
      const pixels: number[] = []
      seen[start] = 1
      let touchesBorder = false
      while (stack.length) {
        const cur = stack.pop()!
        pixels.push(cur)
        const cx = cur % width
        const cy = (cur - cx) / width
        if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1) touchesBorder = true
        for (let k = 0; k < 8; k++) {
          const nx = cx + N8X[k]
          const ny = cy + N8Y[k]
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const j = ny * width + nx
          if (mask[j] || seen[j]) continue
          seen[j] = 1
          stack.push(j)
        }
      }
      if (!touchesBorder && pixels.length <= turd) {
        for (const i of pixels) mask[i] = 1
      }
    }
  }
}

function inside(mask: Uint8Array, width: number, height: number, x: number, y: number) {
  return x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1
}

/** 从每个墨块的左缘出发，沿边界走完一圈。孔洞的左缘也会被走到。 */
function traceBoundaries(mask: Uint8Array, width: number, height: number): Point[][] {
  const used = new Uint8Array(mask.length)
  const loops: Point[][] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x
      if (!mask[start] || used[start]) continue
      if (x > 0 && mask[start - 1]) continue
      const loop = walkLoop(mask, width, height, x, y)
      for (const p of loop) {
        const i = p.y * width + p.x
        if (p.x === 0 || !mask[i - 1]) used[i] = 1
      }
      if (loop.length >= 4) loops.push(loop)
    }
  }
  return loops
}

function walkLoop(mask: Uint8Array, width: number, height: number, sx: number, sy: number): Point[] {
  const loop: Point[] = []
  let x = sx
  let y = sy
  let px = sx - 1
  let py = sy
  const limit = Math.min(mask.length * 2, 800000)
  for (let step = 0; step < limit; step++) {
    loop.push({ x, y })
    let back = 0
    for (let k = 0; k < 8; k++) {
      if (x + N8X[k] === px && y + N8Y[k] === py) {
        back = k
        break
      }
    }
    let nx = -1
    let ny = -1
    let dir = back
    for (let k = 1; k <= 8; k++) {
      const idx = (back + k) & 7
      const qx = x + N8X[idx]
      const qy = y + N8Y[idx]
      if (!inside(mask, width, height, qx, qy)) continue
      nx = qx
      ny = qy
      dir = idx
      break
    }
    if (nx < 0) break
    if (nx === sx && ny === sy) break
    const prev = (dir + 7) & 7
    px = x + N8X[prev]
    py = y + N8Y[prev]
    x = nx
    y = ny
  }
  return loop
}

function polishLoop(loop: Point[]): Point[] {
  if (closedLength(loop) < 4) return []
  // 小墨点简化一下就会没了，原样留下
  if (loop.length < 12) return dedupePoints(loop)
  const simplified = simplifyClosed(loop, 0.85)
  if (simplified.length < 4) return dedupePoints(loop)
  const smooth = smoothPolyline(simplified, true, 3)
  return dedupePoints(resampleSpacing(smooth, 2.2, true))
}

function closedLength(pts: Point[]) {
  if (pts.length < 2) return 0
  const a = pts[0]
  const b = pts[pts.length - 1]
  return arcLength(pts) + Math.hypot(a.x - b.x, a.y - b.y)
}
