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
 * 两层线叠在一起：
 * 深色块仍沿外轮廓描，大块形状保持干净；
 * 另外按局部明暗和色差再描一圈，把色块里面的褶皱、描边和浅色交界补回来。
 * 贴得很近的重复线会丢掉。细节 50 时，深色阈值是 120。
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
  const red = new Float32Array(n)
  const green = new Float32Array(n)
  const blue = new Float32Array(n)
  let lo = 255
  let hi = 0
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const transparent = rgba[i + 3] === 0
    const r = transparent ? 255 : rgba[i]
    const g = transparent ? 255 : rgba[i + 1]
    const b = transparent ? 255 : rgba[i + 2]
    red[p] = r
    green[p] = g
    blue[p] = b
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    luma[p] = y
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  const span = hi - lo
  if (span > 1) {
    for (let i = 0; i < n; i++) luma[i] = ((luma[i] - lo) / span) * 255
  }

  const tNorm = Math.min(100, Math.max(0, detail)) / 100
  const threshold = Math.round(THRESHOLD_AT_MID + (tNorm - 0.5) * 120)
  const invert = cornersAreDark(luma, width, height)
  const solid = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const ink = invert ? luma[i] > threshold : luma[i] < threshold
    if (ink) solid[i] = 1
  }

  const edge = edgeMask(luma, red, green, blue, width, height, tNorm)
  closeGaps(edge, width, height)
  suppressSpeckles(edge, width, height, TURD_SIZE)
  suppressSpeckles(solid, width, height, TURD_SIZE)
  fillTinyHoles(solid, width, height, TURD_SIZE)

  const raw = traceBoundaries(edge, width, height).concat(traceBoundaries(solid, width, height))
  const polished: Point[][] = []
  for (const loop of raw) {
    const points = polishLoop(loop)
    if (closedLength(points) < 4) continue
    polished.push(points)
  }
  const kept = dropNearby(polished, width, height)
  return kept.map((points, id) => ({ id, points, closed: true }))
}

export function indexInkOutlines(contours: Contour[], width: number, height: number) {
  return buildSpatialIndex(contours, width, height)
}

function edgeMask(
  luma: Float32Array,
  red: Float32Array,
  green: Float32Array,
  blue: Float32Array,
  width: number,
  height: number,
  tNorm: number,
) {
  const fine = boxBlur(luma, width, height, 2)
  const wide = boxBlur(luma, width, height, 6)
  const br = boxBlur(red, width, height, 3)
  const bg = boxBlur(green, width, height, 3)
  const bb = boxBlur(blue, width, height, 3)
  // 细节越高，越弱的交界也留下
  const margin = 22 - tNorm * 10
  const wideMargin = margin + 8
  const colorCut = 36 - tNorm * 16
  const colorCut2 = colorCut * colorCut
  const mask = new Uint8Array(luma.length)
  for (let i = 0; i < luma.length; i++) {
    const darker =
      luma[i] + margin < fine[i] || luma[i] + wideMargin < wide[i]
    const dr = red[i] - br[i]
    const dg = green[i] - bg[i]
    const db = blue[i] - bb[i]
    const chroma = Math.max(red[i], green[i], blue[i]) - Math.min(red[i], green[i], blue[i])
    // 浅色光晕不记。只认更暗的像素，或者像素本身就带颜色。
    const colored = chroma > 18 && dr * dr + dg * dg + db * db > colorCut2
    if (darker || colored) mask[i] = 1
  }
  return mask
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number) {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const prefix = new Float32Array(Math.max(width, height) + 1)
  for (let y = 0; y < height; y++) {
    const row = y * width
    prefix[0] = 0
    for (let x = 0; x < width; x++) prefix[x + 1] = prefix[x] + src[row + x]
    for (let x = 0; x < width; x++) {
      const a = Math.max(0, x - radius)
      const b = Math.min(width - 1, x + radius)
      tmp[row + x] = (prefix[b + 1] - prefix[a]) / (b - a + 1)
    }
  }
  for (let x = 0; x < width; x++) {
    prefix[0] = 0
    for (let y = 0; y < height; y++) prefix[y + 1] = prefix[y] + tmp[y * width + x]
    for (let y = 0; y < height; y++) {
      const a = Math.max(0, y - radius)
      const b = Math.min(height - 1, y + radius)
      out[y * width + x] = (prefix[b + 1] - prefix[a]) / (b - a + 1)
    }
  }
  return out
}

/** 把断成一个像素的边粘上，再收回到原来的粗细。 */
function closeGaps(mask: Uint8Array, width: number, height: number) {
  const grown = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          grown[ny * width + nx] = 1
        }
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!grown[i]) continue
      let keep = true
      for (let dy = -1; dy <= 1 && keep; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          if (!grown[ny * width + nx]) {
            keep = false
            break
          }
        }
      }
      mask[i] = keep ? 1 : 0
    }
  }
}

/** 和已经留下的线几乎重合的圈丢掉，避免同一条边描两遍。 */
function dropNearby(loops: Point[][], width: number, height: number) {
  const cell = 4
  const cols = Math.ceil(width / cell) + 2
  const rows = Math.ceil(height / cell) + 2
  const buckets: Point[][] = Array.from({ length: cols * rows }, () => [])
  const near2 = 4.2 * 4.2
  const at = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(cols - 1, Math.floor(x / cell) + 1))
    const cy = Math.max(0, Math.min(rows - 1, Math.floor(y / cell) + 1))
    return cy * cols + cx
  }
  const ranked = loops
    .map((points) => ({ points, len: closedLength(points) }))
    .filter((item) => item.len >= 4)
    .sort((a, b) => b.len - a.len)
  const kept: Point[][] = []
  for (const item of ranked) {
    const pts = item.points
    const step = Math.max(1, Math.floor(pts.length / 28))
    let samples = 0
    let close = 0
    for (let i = 0; i < pts.length; i += step) {
      samples++
      const p = pts[i]
      const cx = Math.floor(p.x / cell) + 1
      const cy = Math.floor(p.y / cell) + 1
      let hit = false
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue
          const bucket = buckets[y * cols + x]
          for (const q of bucket) {
            const ddx = q.x - p.x
            const ddy = q.y - p.y
            if (ddx * ddx + ddy * ddy <= near2) {
              hit = true
              break
            }
          }
          if (hit) break
        }
      }
      if (hit) close++
    }
    if (samples > 0 && close / samples > 0.68) continue
    kept.push(pts)
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i]
      buckets[at(p.x, p.y)].push(p)
    }
  }
  return kept
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
