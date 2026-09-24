export type Point = { x: number; y: number }

export type Contour = {
  id: number
  points: Point[]
  closed: boolean
}

type Hit = { contourId: number; index: number; dist: number }

const N8: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

function at(img: Uint8Array, x: number, y: number, w: number, h: number) {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0
  return img[y * w + x]
}

/** Zhang-Suen 细化，得到单像素骨架 */
export function thinSkeleton(
  src: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const img = new Uint8Array(src)
  const flagged = new Uint8Array(width * height)
  let changed = true
  let guard = 0

  while (changed && guard++ < 72) {
    changed = false
    for (const step of [1, 2] as const) {
      flagged.fill(0)
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x
          if (!img[i]) continue
          const p2 = at(img, x, y - 1, width, height)
          const p3 = at(img, x + 1, y - 1, width, height)
          const p4 = at(img, x + 1, y, width, height)
          const p5 = at(img, x + 1, y + 1, width, height)
          const p6 = at(img, x, y + 1, width, height)
          const p7 = at(img, x - 1, y + 1, width, height)
          const p8 = at(img, x - 1, y, width, height)
          const p9 = at(img, x - 1, y - 1, width, height)
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9]
          let b = 0
          let a = 0
          for (let k = 0; k < 8; k++) {
            b += ring[k]
            if (ring[k] === 0 && ring[(k + 1) % 8] === 1) a++
          }
          if (b < 2 || b > 6 || a !== 1) continue
          if (step === 1 && (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0)) continue
          if (step === 2 && (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0)) continue
          flagged[i] = 1
        }
      }
      for (let i = 0; i < flagged.length; i++) {
        if (flagged[i]) {
          img[i] = 0
          changed = true
        }
      }
    }
  }
  return img
}

function neighborCount(
  img: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  let n = 0
  for (const [dx, dy] of N8) {
    if (at(img, x + dx, y + dy, width, height)) n++
  }
  return n
}

function nextUnused(
  img: Uint8Array,
  used: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  prevX: number,
  prevY: number,
): [number, number] | null {
  let best: [number, number] | null = null
  let bestScore = -1e9
  const vx = x - prevX
  const vy = y - prevY
  for (const [dx, dy] of N8) {
    const nx = x + dx
    const ny = y + dy
    if (!at(img, nx, ny, width, height)) continue
    const j = ny * width + nx
    if (used[j]) continue
    const score = vx * dx + vy * dy
    if (score > bestScore) {
      bestScore = score
      best = [nx, ny]
    }
  }
  return best
}

function removeSmallComponents(
  skel: Uint8Array,
  width: number,
  height: number,
  minSize: number,
) {
  const seen = new Uint8Array(skel.length)
  const stack: number[] = []
  for (let i = 0; i < skel.length; i++) {
    if (!skel[i] || seen[i]) continue
    stack.length = 0
    stack.push(i)
    seen[i] = 1
    const comp: number[] = []
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      const x = cur % width
      const y = (cur - x) / width
      for (const [dx, dy] of N8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (!skel[j] || seen[j]) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    if (comp.length < minSize) {
      for (const j of comp) skel[j] = 0
    }
  }
}

function pruneSpurs(
  skel: Uint8Array,
  width: number,
  height: number,
  maxSpur: number,
) {
  let changed = true
  let guard = 0
  while (changed && guard++ < 30) {
    changed = false
    const ends: Array<[number, number]> = []
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (!skel[y * width + x]) continue
        if (neighborCount(skel, x, y, width, height) === 1) ends.push([x, y])
      }
    }
    for (const [sx, sy] of ends) {
      if (!skel[sy * width + sx]) continue
      const chain: number[] = []
      let x = sx
      let y = sy
      let px = x
      let py = y
      for (let step = 0; step < maxSpur + 2; step++) {
        const i = y * width + x
        chain.push(i)
        const deg = neighborCount(skel, x, y, width, height)
        if (step > 0 && deg !== 2) break
        let nx = -1
        let ny = -1
        for (const [dx, dy] of N8) {
          const qx = x + dx
          const qy = y + dy
          if (!at(skel, qx, qy, width, height)) continue
          if (qx === px && qy === py) continue
          nx = qx
          ny = qy
          break
        }
        if (nx < 0) break
        px = x
        py = y
        x = nx
        y = ny
      }
      const last = chain[chain.length - 1]
      const lx = last % width
      const ly = (last - lx) / width
      const lastDeg = neighborCount(skel, lx, ly, width, height)
      if (chain.length <= maxSpur + 1 && lastDeg >= 3) {
        for (let k = 0; k < chain.length - 1; k++) skel[chain[k]] = 0
        changed = true
      }
    }
  }
}

/** 把骨架追踪成折线；沿最直方向穿过分叉，闭环标为 closed */
export function traceContours(
  skel: Uint8Array,
  width: number,
  height: number,
): Contour[] {
  removeSmallComponents(skel, width, height, 14)
  pruneSpurs(skel, width, height, 10)

  const used = new Uint8Array(skel.length)
  const endpoints: Array<[number, number]> = []

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      if (!skel[i]) continue
      if (neighborCount(skel, x, y, width, height) <= 1) endpoints.push([x, y])
    }
  }

  const contours: Contour[] = []
  let id = 0

  const walk = (sx: number, sy: number): Point[] => {
    const path: Point[] = [{ x: sx, y: sy }]
    used[sy * width + sx] = 1
    let px = sx
    let py = sy
    let cur = nextUnused(skel, used, sx, sy, width, height, sx + 1, sy)
    while (cur) {
      const [nx, ny] = cur
      path.push({ x: nx, y: ny })
      used[ny * width + nx] = 1
      const nxt = nextUnused(skel, used, nx, ny, width, height, px, py)
      px = nx
      py = ny
      cur = nxt
    }
    return path
  }

  for (const [x, y] of endpoints) {
    if (used[y * width + x]) continue
    const pts = walk(x, y)
    if (pts.length >= 2) {
      contours.push({ id: id++, points: pts, closed: false })
    }
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      if (!skel[i] || used[i]) continue
      const pts = walk(x, y)
      if (pts.length >= 3) {
        const a = pts[0]
        const b = pts[pts.length - 1]
        const closed = Math.hypot(a.x - b.x, a.y - b.y) <= 2
        contours.push({ id: id++, points: pts, closed })
      }
    }
  }

  const kept = contours.filter((c) => c.points.length >= 8)
  return stitchContours(kept)
}

/** 把端点相接、走向接近的短折线接成长轮廓 */
function stitchContours(input: Contour[]): Contour[] {
  const contours = input.map((c, i) => ({
    ...c,
    id: i,
    points: c.points.slice(),
  }))
  let changed = true
  let guard = 0
  while (changed && guard++ < 40) {
    changed = false
    for (let i = 0; i < contours.length; i++) {
      const a = contours[i]
      if (!a || a.closed) continue
      const aEnd = a.points[a.points.length - 1]
      const aTan = tangentAt(a.points, a.points.length - 1, -1)
      let bestJ = -1
      let bestFlip = false
      let bestScore = 0.35
      for (let j = 0; j < contours.length; j++) {
        if (i === j) continue
        const b = contours[j]
        if (!b || b.closed) continue
        const b0 = b.points[0]
        const b1 = b.points[b.points.length - 1]
        const d0 = Math.hypot(aEnd.x - b0.x, aEnd.y - b0.y)
        const d1 = Math.hypot(aEnd.x - b1.x, aEnd.y - b1.y)
        if (d0 <= 3.2) {
          const bTan = tangentAt(b.points, 0, 1)
          const score = aTan.x * bTan.x + aTan.y * bTan.y
          if (score > bestScore) {
            bestScore = score
            bestJ = j
            bestFlip = false
          }
        }
        if (d1 <= 3.2) {
          const bTan = tangentAt(b.points, b.points.length - 1, -1)
          const score = aTan.x * -bTan.x + aTan.y * -bTan.y
          if (score > bestScore) {
            bestScore = score
            bestJ = j
            bestFlip = true
          }
        }
      }
      if (bestJ < 0) continue
      const other = contours[bestJ]
      const extra = bestFlip ? other.points.slice().reverse() : other.points
      a.points.push(...extra.slice(1))
      contours.splice(bestJ, 1)
      changed = true
      break
    }
  }
  return contours
    .filter((c) => c.points.length >= 10)
    .map((c, i) => ({ ...c, id: i }))
}

function tangentAt(pts: Point[], i: number, dir: number) {
  const j = Math.min(pts.length - 1, Math.max(0, i + dir * 3))
  const dx = pts[j].x - pts[i].x
  const dy = pts[j].y - pts[i].y
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}

export type SpatialIndex = {
  cell: number
  cols: number
  rows: number
  buckets: Array<Array<{ cid: number; idx: number }>>
}

export function buildSpatialIndex(
  contours: Contour[],
  width: number,
  height: number,
  cell = 12,
): SpatialIndex {
  const cols = Math.max(1, Math.ceil(width / cell))
  const rows = Math.max(1, Math.ceil(height / cell))
  const buckets: SpatialIndex['buckets'] = Array.from(
    { length: cols * rows },
    () => [],
  )
  for (const c of contours) {
    for (let i = 0; i < c.points.length; i++) {
      const p = c.points[i]
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cell)))
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cell)))
      buckets[cy * cols + cx].push({ cid: c.id, idx: i })
    }
  }
  return { cell, cols, rows, buckets }
}

function queryHits(
  x: number,
  y: number,
  radius: number,
  contours: Contour[],
  index: SpatialIndex,
): Hit[] {
  const r = radius
  const minX = Math.max(0, Math.floor((x - r) / index.cell))
  const maxX = Math.min(index.cols - 1, Math.floor((x + r) / index.cell))
  const minY = Math.max(0, Math.floor((y - r) / index.cell))
  const maxY = Math.min(index.rows - 1, Math.floor((y + r) / index.cell))
  const best = new Map<number, Hit>()
  const byId = new Map(contours.map((c) => [c.id, c]))
  const r2 = r * r
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const bucket = index.buckets[cy * index.cols + cx]
      for (const item of bucket) {
        const p = byId.get(item.cid)?.points[item.idx]
        if (!p) continue
        const d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
        if (d2 > r2) continue
        const prev = best.get(item.cid)
        if (!prev || d2 < prev.dist * prev.dist) {
          best.set(item.cid, {
            contourId: item.cid,
            index: item.idx,
            dist: Math.sqrt(d2),
          })
        }
      }
    }
  }
  return [...best.values()]
}

function nearestOnContour(
  x: number,
  y: number,
  contour: Contour,
  radius: number,
  hint = -1,
): Hit | null {
  const pts = contour.points
  let lo = 0
  let hi = pts.length - 1
  if (hint >= 0) {
    const win = 48
    lo = Math.max(0, hint - win)
    hi = Math.min(pts.length - 1, hint + win)
  }
  let bestI = -1
  let bestD = radius + 1
  for (let i = lo; i <= hi; i++) {
    const p = pts[i]
    const d = Math.hypot(p.x - x, p.y - y)
    if (d < bestD) {
      bestD = d
      bestI = i
    }
  }
  if (bestI < 0 || bestD > radius) {
    if (hint >= 0) return nearestOnContour(x, y, contour, radius, -1)
    return null
  }
  return { contourId: contour.id, index: bestI, dist: bestD }
}

function unwrapDelta(d: number, n: number, closed: boolean) {
  if (!closed) return d
  if (d > n / 2) return d - n
  if (d < -n / 2) return d + n
  return d
}

function extractSubpath(
  contour: Contour,
  startIdx: number,
  endIdx: number,
  signedTravel: number,
): Point[] {
  const pts = contour.points
  const n = pts.length
  if (n === 0) return []
  if (Math.abs(signedTravel) < 1 && Math.abs(endIdx - startIdx) < 1) {
    const i0 = Math.max(0, startIdx - 3)
    const i1 = Math.min(n - 1, startIdx + 3)
    return pts.slice(i0, i1 + 1)
  }
  const dir = signedTravel >= 0 ? 1 : -1
  const out: Point[] = []
  let i = startIdx
  const limit = Math.min(n * 2, Math.max(2, Math.round(Math.abs(signedTravel)) + 2))
  for (let step = 0; step <= limit; step++) {
    out.push(pts[((i % n) + n) % n])
    if (step > 0 && ((i % n) + n) % n === endIdx) break
    if (!contour.closed && (i + dir < 0 || i + dir >= n)) break
    i += dir
  }
  return out
}

export type SnapResult = {
  points: Point[]
  contourId: number
}

/**
 * 把一串输入点吸附到最近轮廓的一段：取首末投影，
 * 按用户行进方向沿轮廓取样，空白处（超半径）不贡献。
 */
export function snapPointsToContour(
  raw: Point[],
  contours: Contour[],
  index: SpatialIndex,
  radius: number,
  preferId = -1,
): SnapResult | null {
  if (raw.length === 0 || contours.length === 0) return null

  const byId = new Map(contours.map((c) => [c.id, c]))
  const votes = new Map<number, { hits: number; dist: number }>()

  for (const p of raw) {
    const hits = queryHits(p.x, p.y, radius, contours, index)
    for (const h of hits) {
      const v = votes.get(h.contourId) ?? { hits: 0, dist: 0 }
      v.hits++
      v.dist += h.dist
      votes.set(h.contourId, v)
    }
  }

  const preferVotes = votes.get(preferId)
  let chosen = -1
  if (preferVotes && preferVotes.hits >= raw.length * 0.34) {
    chosen = preferId
  } else {
    let bestScore = -1e9
    for (const [cid, v] of votes) {
      const len = byId.get(cid)?.points.length ?? 0
      const score =
        v.hits * 3 +
        len * 0.04 -
        v.dist / Math.max(1, v.hits) / Math.max(1, radius)
      if (score > bestScore) {
        bestScore = score
        chosen = cid
      }
    }
  }

  const contour = byId.get(chosen)
  if (!contour) return null

  const hitRate = (votes.get(chosen)?.hits ?? 0) / raw.length
  if (raw.length > 4 && hitRate < 0.18) return null

  const projections: number[] = []
  let hint = -1
  for (const p of raw) {
    const h = nearestOnContour(p.x, p.y, contour, radius, hint)
    if (!h) continue
    projections.push(h.index)
    hint = h.index
  }
  if (projections.length === 0) return null

  const n = contour.points.length
  let signed = 0
  for (let i = 1; i < projections.length; i++) {
    signed += unwrapDelta(projections[i] - projections[i - 1], n, contour.closed)
  }
  if (Math.abs(signed) < 1) {
    signed = unwrapDelta(
      projections[projections.length - 1] - projections[0],
      n,
      contour.closed,
    )
  }

  const points = extractSubpath(
    contour,
    projections[0],
    projections[projections.length - 1],
    signed,
  )
  if (points.length < 2) return null
  return { points, contourId: contour.id }
}

export class SnapSession {
  raw: Point[] = []
  private preferId = -1
  private contours: Contour[]
  private index: SpatialIndex
  private radius: number

  constructor(contours: Contour[], index: SpatialIndex, radius: number) {
    this.contours = contours
    this.index = index
    this.radius = radius
  }

  add(x: number, y: number) {
    const last = this.raw[this.raw.length - 1]
    if (last && Math.hypot(last.x - x, last.y - y) < 0.8) return
    this.raw.push({ x, y })
    if (this.preferId < 0 && this.raw.length >= 5) {
      const r = snapPointsToContour(
        this.raw,
        this.contours,
        this.index,
        this.radius,
        -1,
      )
      if (r) this.preferId = r.contourId
    }
  }

  live(): Point[] | null {
    const r = snapPointsToContour(
      this.raw,
      this.contours,
      this.index,
      this.radius,
      this.preferId,
    )
    if (r) this.preferId = r.contourId
    return r?.points ?? null
  }

  finalize(): Point[] | null {
    return (
      snapPointsToContour(
        this.raw,
        this.contours,
        this.index,
        this.radius,
        this.preferId,
      )?.points ?? null
    )
  }
}
