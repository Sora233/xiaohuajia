import {
  buildSpatialIndex,
  takeTraceTimings,
  thinSkeleton,
  traceContours,
  type Contour,
  type SpatialIndex,
  type TraceTimings,
} from '@/lib/contours'
import { arcLength, dedupePoints, resampleSpacing, simplifyClosed, smoothPolyline, type Point } from '@/lib/polyline'

export type ExtractionTimings = {
  mask: number
  thin: number
  trace: number
  index: number
  total: number
  traceDetail: TraceTimings | null
}

export type ExtractionResult = {
  contours: Contour[]
  index: SpatialIndex
  timings: ExtractionTimings
}

function gaussianBlur5(src: Float32Array, width: number, height: number): Float32Array {
  // 可分离 5-tap 近似高斯核
  const kernel = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136]
  const tmp = new Float32Array(width * height)
  const out = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k))
        acc += src[row + xx] * kernel[k + 2]
      }
      tmp[row + x] = acc
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k))
        acc += tmp[yy * width + x] * kernel[k + 2]
      }
      out[y * width + x] = acc
    }
  }
  return out
}

/**
 * 从 RGBA 像素提取二值线掩膜：照片用 Sobel 边，线稿只用深色墨迹。
 * `detail`：0–100，越大保留越弱的边。
 */
export function extractMaskFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  detail: number,
): { mask: Uint8Array; lineArt: boolean } {
  const n = width * height
  const gray = new Float32Array(n)

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }

  let extreme = 0
  for (let i = 0; i < n; i++) {
    const g = gray[i]
    if (g < 48 || g > 220) extreme++
  }

  const blurred = gaussianBlur5(gray, width, height)
  const mag = new Float32Array(n)
  let maxMag = 1
  let meanGray = 0

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx =
        -blurred[i - width - 1] +
        blurred[i - width + 1] -
        2 * blurred[i - 1] +
        2 * blurred[i + 1] -
        blurred[i + width - 1] +
        blurred[i + width + 1]
      const gy =
        -blurred[i - width - 1] -
        2 * blurred[i - width] -
        blurred[i - width + 1] +
        blurred[i + width - 1] +
        2 * blurred[i + width] +
        blurred[i + width + 1]
      const m = Math.hypot(gx, gy)
      mag[i] = m
      if (m > maxMag) maxMag = m
    }
  }

  for (let i = 0; i < n; i++) meanGray += blurred[i]
  meanGray /= n

  // 大块实心黑会把平均灰度拉低，但像素仍几乎只有黑和白
  const looksLikeLineArt = meanGray > 150 || extreme / n > 0.82
  const tNorm = Math.min(100, Math.max(0, detail)) / 100
  const edgeT = maxMag * (0.4 - tNorm * 0.34)
  const inkT = looksLikeLineArt ? 176 : 108 + (1 - tNorm) * 42

  const mark = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const edge = mag[i] >= edgeT
    const ink = blurred[i] < inkT
    // 线稿只用墨迹，避免 Sobel 把每条线描成双边再撕碎骨架
    mark[i] = looksLikeLineArt ? (ink ? 1 : 0) : edge ? 1 : 0
  }
  return { mask: mark, lineArt: looksLikeLineArt }
}

const N8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]

function dilate8(src: Uint8Array, width: number, height: number) {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!src[y * width + x]) continue
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          out[ny * width + nx] = 1
        }
      }
    }
  }
  return out
}

function erode8(src: Uint8Array, width: number, height: number) {
  const out = new Uint8Array(src.length)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      if (!src[i]) continue
      let keep = true
      for (let dy = -1; dy <= 1 && keep; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!src[i + dy * width + dx]) {
            keep = false
            break
          }
        }
      }
      if (keep) out[i] = 1
    }
  }
  return out
}

/** 先膨胀再腐蚀，把 1～2 像素的断口粘上，十几像素的平行线不会被焊住 */
function closeRadius1(src: Uint8Array, width: number, height: number) {
  return erode8(dilate8(src, width, height), width, height)
}

function erodeChebyshev(src: Uint8Array, width: number, height: number, radius: number) {
  const out = new Uint8Array(src.length)
  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      let keep = true
      for (let dy = -radius; dy <= radius && keep; dy++) {
        const row = (y + dy) * width
        for (let dx = -radius; dx <= radius; dx++) {
          if (!src[row + x + dx]) {
            keep = false
            break
          }
        }
      }
      if (keep) out[y * width + x] = 1
    }
  }
  return out
}

/** 封上比半径更窄的小孔。半径 3 大约补 6px，十几像素的平行缝还在 */
function closeChebyshev(src: Uint8Array, width: number, height: number, radius: number) {
  return erodeChebyshev(dilateChebyshev(src, width, height, radius), width, height, radius)
}

/** 从图像边缘灌进背景，灌不到的空洞填上，避免网点内部抽出一圈圈假轮廓 */
function fillHoles(mask: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  let tail = 0
  const push = (i: number) => {
    if (mask[i] || seen[i]) return
    seen[i] = 1
    queue[tail++] = i
  }
  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }
  let head = 0
  while (head < tail) {
    const cur = queue[head++]
    const x = cur % width
    const y = (cur - x) / width
    if (x > 0) push(cur - 1)
    if (x + 1 < width) push(cur + 1)
    if (y > 0) push(cur - width)
    if (y + 1 < height) push(cur + width)
  }
  const out = mask.slice()
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !seen[i]) out[i] = 1
  }
  return out
}

function dilateChebyshev(src: Uint8Array, width: number, height: number, radius: number) {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!src[y * width + x]) continue
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      for (let ny = y0; ny <= y1; ny++) {
        const row = ny * width
        for (let nx = x0; nx <= x1; nx++) out[row + nx] = 1
      }
    }
  }
  return out
}

/** 到背景的棋盘距离，用来区分粗线条和实心黑块 */
function distanceToBackground(mask: Uint8Array, width: number, height: number) {
  const dist = new Uint16Array(mask.length)
  const queue = new Int32Array(mask.length)
  let head = 0
  let tail = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!mask[i]) continue
      let edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
      if (!edge) {
        for (const [dx, dy] of N8) {
          if (!mask[i + dy * width + dx]) {
            edge = true
            break
          }
        }
      }
      if (!edge) continue
      dist[i] = 1
      queue[tail++] = i
    }
  }
  while (head < tail) {
    const cur = queue[head++]
    const next = dist[cur] + 1
    const x = cur % width
    const y = (cur - x) / width
    for (const [dx, dy] of N8) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const j = ny * width + nx
      if (!mask[j] || dist[j] !== 0) continue
      dist[j] = next
      queue[tail++] = j
    }
  }
  return dist
}

type Blob = {
  area: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  maxDepth: number
  pixels: number[]
}

function labelMask(mask: Uint8Array, width: number, height: number, depth?: Uint16Array) {
  const labels = new Int32Array(mask.length)
  const blobs: Blob[] = []
  const queue = new Int32Array(mask.length)
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    const id = blobs.length + 1
    let head = 0
    let tail = 0
    queue[tail++] = start
    labels[start] = id
    const pixels: number[] = []
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let maxDepth = 0
    while (head < tail) {
      const cur = queue[head++]
      pixels.push(cur)
      const x = cur % width
      const y = (cur - x) / width
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (depth && depth[cur] > maxDepth) maxDepth = depth[cur]
      for (const [dx, dy] of N8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (!mask[j] || labels[j]) continue
        labels[j] = id
        queue[tail++] = j
      }
    }
    blobs.push({ area: pixels.length, minX, minY, maxX, maxY, maxDepth, pixels })
  }
  return blobs
}

function isCompact(blob: Blob) {
  const bw = blob.maxX - blob.minX + 1
  const bh = blob.maxY - blob.minY + 1
  const minor = Math.min(bw, bh)
  const major = Math.max(bw, bh)
  const fill = blob.area / (bw * bh)
  // 只把成块的实心和网点收成外轮廓。天线交叉、线端那种小厚块仍走中心线，避免把线掐断
  return blob.area >= 800 && minor >= 28 && fill >= 0.2 && major < minor * 5.5
}

/**
 * 细化之前先收拾线稿：
 * 网点、网点簇只留外轮廓；实心黑块留边界；粗线留给细化去收成中心线；
 * 1～2 像素的断口先粘上。照片仍走原来的细边，只补极小的断口。
 */
/** 顺着区域外轮廓走一圈。只从左边缘起步，避免同一圈被描多次 */
function traceRegionOutlines(region: Uint8Array, width: number, height: number): Point[][] {
  const dx = [1, 1, 0, -1, -1, -1, 0, 1]
  const dy = [0, 1, 1, 1, 0, -1, -1, -1]
  const seen = new Uint8Array(region.length)
  const loops: Point[][] = []
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && region[y * width + x] === 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x
      if (!region[start] || seen[start]) continue
      if (x > 0 && region[start - 1]) continue
      const pts: Point[] = [{ x, y }]
      seen[start] = 1
      let cx = x
      let cy = y
      let bx = x - 1
      let by = y
      const limit = Math.min(region.length, 200000)
      for (let step = 0; step < limit; step++) {
        let back = 0
        for (let k = 0; k < 8; k++) {
          if (cx + dx[k] === bx && cy + dy[k] === by) {
            back = k
            break
          }
        }
        let nx = -1
        let ny = -1
        let nback = back
        for (let k = 1; k <= 8; k++) {
          const idx = (back + k) & 7
          const qx = cx + dx[idx]
          const qy = cy + dy[idx]
          if (!inside(qx, qy)) continue
          nx = qx
          ny = qy
          nback = (idx + 7) & 7
          break
        }
        if (nx < 0) break
        if (nx === x && ny === y) break
        const ni = ny * width + nx
        if (seen[ni] && pts.length > 8) break
        seen[ni] = 1
        pts.push({ x: nx, y: ny })
        bx = cx + dx[nback]
        by = cy + dy[nback]
        cx = nx
        cy = ny
      }
      if (pts.length >= 12) loops.push(pts)
    }
  }
  return loops
}

function prepareLineMask(
  mask: Uint8Array,
  width: number,
  height: number,
  lineArt: boolean,
): { mask: Uint8Array; loops: Point[][] } {
  if (!lineArt) {
    const tiny = mask.slice()
    for (const blob of labelMask(tiny, width, height)) {
      if (blob.area > 4) continue
      for (const i of blob.pixels) tiny[i] = 0
    }
    return { mask: closeRadius1(tiny, width, height), loops: [] }
  }

  // 半径 3 大约补 6px。屏幕网点的孔大多在这以内，外框和屏幕之间的十几像素缝还在
  const sealed = closeChebyshev(mask, width, height, 3)
  const depth = distanceToBackground(sealed, width, height)
  const blobs = labelMask(sealed, width, height, depth)
  const speckle = new Uint8Array(mask.length)
  for (const blob of blobs) {
    if (blob.area > 18) continue
    for (const i of blob.pixels) speckle[i] = 1
  }

  const grown = dilateChebyshev(speckle, width, height, 3)
  const texture = new Uint8Array(mask.length)
  for (const blob of labelMask(grown, width, height)) {
    if (blob.area < 120) continue
    let dots = 0
    for (const i of blob.pixels) if (speckle[i]) dots++
    if (dots < 8) continue
    for (const i of blob.pixels) texture[i] = 1
  }

  const core = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) {
    if (sealed[i] && !speckle[i] && depth[i] >= 5) core[i] = 1
  }
  const solid = new Uint8Array(mask.length)
  const walked = new Int16Array(mask.length)
  const cores = labelMask(core, width, height, depth).sort((a, b) => b.area - a.area)
  const queue = new Int32Array(mask.length)
  for (const blob of cores) {
    if (!isCompact(blob)) continue
    // 只补回核心外面薄薄一圈。按最大深度往外长会顺着粗线漏到整条胳膊
    const steps = 8
    let head = 0
    let tail = 0
    for (const i of blob.pixels) {
      if (solid[i]) continue
      solid[i] = 1
      walked[i] = 1
      queue[tail++] = i
    }
    while (head < tail) {
      const cur = queue[head++]
      const dist = walked[cur]
      if (dist > steps) continue
      const x = cur % width
      const y = (cur - x) / width
      for (const [dx, dy] of N8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (!sealed[j] || speckle[j] || solid[j]) continue
        solid[j] = 1
        walked[j] = dist + 1
        queue[tail++] = j
      }
    }
  }

  const filled = fillHoles(solid, width, height)
  const textured = new Uint8Array(sealed.length)
  for (let i = 0; i < sealed.length; i++) {
    if (texture[i] && !filled[i]) textured[i] = 1
  }
  const halo = dilateChebyshev(filled, width, height, 6)
  const textureHalo = dilateChebyshev(textured, width, height, 4)
  const stroke = new Uint8Array(sealed.length)
  for (let i = 0; i < sealed.length; i++) {
    // 贴着实心块的那一圈笔画就是它的边，留给外轮廓，不再抽成第二条线
    if (halo[i] || textureHalo[i] || filled[i] || textured[i] || speckle[i]) continue
    if (sealed[i]) stroke[i] = 1
  }
  const loops = traceRegionOutlines(filled, width, height).concat(traceRegionOutlines(textured, width, height))
  return { mask: closeRadius1(stroke, width, height), loops }
}

/** 掩膜 → 细化 → 长轮廓 → 空间索引。不碰 DOM，可在 Worker 里跑。 */
export function runExtraction(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  detail: number,
): ExtractionResult {
  const t0 = performance.now()
  const extracted = extractMaskFromRgba(rgba, width, height, detail)
  const prepared = prepareLineMask(extracted.mask, width, height, extracted.lineArt)
  const tMask = performance.now()
  const skel = thinSkeleton(prepared.mask, width, height)
  const tThin = performance.now()
  const contours = traceContours(skel, width, height)
  for (const loop of prepared.loops) {
    const simplified = simplifyClosed(loop, 1.15)
    if (simplified.length < 4) continue
    const points = dedupePoints(resampleSpacing(smoothPolyline(simplified, true, 2), 2.25, true))
    if (points.length < 4 || arcLength(points) < 24) continue
    contours.push({ id: contours.length, points, closed: true })
  }
  const tTrace = performance.now()
  const index = buildSpatialIndex(contours, width, height)
  const tIndex = performance.now()
  return {
    contours,
    index,
    timings: {
      mask: tMask - t0,
      thin: tThin - tMask,
      trace: tTrace - tThin,
      index: tIndex - tTrace,
      total: tIndex - t0,
      traceDetail: takeTraceTimings(),
    },
  }
}
