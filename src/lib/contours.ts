import {
  arcLength,
  dedupePoints,
  normalize,
  resampleSpacing,
  simplifyClosed,
  simplifyOpen,
  smoothPolyline,
  type Point,
} from '@/lib/polyline'

export type { Point }

export type Contour = {
  id: number
  points: Point[]
  closed: boolean
}

export type NearestHit = { contourId: number; index: number; dist: number }

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

/**
 * 细化后常留下 2×2 小块，整段轮廓会变成密密麻麻的假分叉。
 * 每块删掉邻居最多的那一像素，直到不再有实心小方块。
 */
function collapseSquares(skel: Uint8Array, width: number, height: number) {
  let guard = 0
  let changed = true
  while (changed && guard++ < 12) {
    changed = false
    const kill: number[] = []
    const seen = new Uint8Array(skel.length)
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const a = y * width + x
        const b = a + 1
        const c = a + width
        const d = c + 1
        if (!skel[a] || !skel[b] || !skel[c] || !skel[d]) continue
        const cands = [a, b, c, d]
        let best = a
        let bestN = -1
        for (const i of cands) {
          if (seen[i]) continue
          const px = i % width
          const py = (i - px) / width
          const n = neighborCount(skel, px, py, width, height)
          if (n > bestN) {
            bestN = n
            best = i
          }
        }
        if (seen[best]) continue
        seen[best] = 1
        kill.push(best)
      }
    }
    for (const i of kill) {
      if (skel[i]) {
        skel[i] = 0
        changed = true
      }
    }
  }
}

/** 删掉从端点伸向分叉、短于 maxSpur 的毛刺，避免抢方向 */
function pruneSpurs(
  skel: Uint8Array,
  width: number,
  height: number,
  maxSpur: number,
) {
  let changed = true
  let guard = 0
  while (changed && guard++ < 40) {
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

type Edge = { points: Point[] }

function bondKey(x1: number, y1: number, x2: number, y2: number) {
  if (x1 < x2 || (x1 === x2 && y1 <= y2)) return `${x1},${y1}|${x2},${y2}`
  return `${x2},${y2}|${x1},${y1}`
}

/** 在分叉处断开，抽出端点/结点之间的原子链，环单独成链 */
function traceAtomicEdges(
  skel: Uint8Array,
  width: number,
  height: number,
): { edges: Edge[]; loops: Point[][] } {
  const degAt = (x: number, y: number) => neighborCount(skel, x, y, width, height)
  const used = new Set<string>()
  const edges: Edge[] = []
  const loops: Point[][] = []

  const walk = (sx: number, sy: number, nx: number, ny: number): Point[] => {
    const pts: Point[] = [
      { x: sx, y: sy },
      { x: nx, y: ny },
    ]
    used.add(bondKey(sx, sy, nx, ny))
    let px = sx
    let py = sy
    let cx = nx
    let cy = ny
    let guard = 0
    const limit = width * height
    while (degAt(cx, cy) === 2 && guard++ < limit) {
      let nx2 = -1
      let ny2 = -1
      for (const [dx, dy] of N8) {
        const qx = cx + dx
        const qy = cy + dy
        if (!at(skel, qx, qy, width, height)) continue
        if (qx === px && qy === py) continue
        nx2 = qx
        ny2 = qy
        break
      }
      if (nx2 < 0) break
      if (used.has(bondKey(cx, cy, nx2, ny2))) break
      used.add(bondKey(cx, cy, nx2, ny2))
      pts.push({ x: nx2, y: ny2 })
      px = cx
      py = cy
      cx = nx2
      cy = ny2
    }
    return pts
  }

  const consider = (x: number, y: number) => {
    for (const [dx, dy] of N8) {
      const nx = x + dx
      const ny = y + dy
      if (!at(skel, nx, ny, width, height)) continue
      if (used.has(bondKey(x, y, nx, ny))) continue
      const pts = walk(x, y, nx, ny)
      if (pts.length < 2) continue
      const a = pts[0]
      const b = pts[pts.length - 1]
      if (a.x === b.x && a.y === b.y && pts.length > 3) loops.push(pts.slice(0, -1))
      else edges.push({ points: pts })
    }
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!skel[y * width + x]) continue
      if (degAt(x, y) === 2) continue
      consider(x, y)
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!skel[y * width + x]) continue
      if (degAt(x, y) !== 2) continue
      consider(x, y)
    }
  }
  return { edges, loops }
}

function portTangent(pts: Point[], atStart: boolean): Point {
  // 跳过紧贴结点的几像素，结点上的骨架会被分叉挤歪
  const skip = Math.min(5, Math.max(0, Math.floor((pts.length - 1) / 4)))
  const reach = Math.min(pts.length - 1, skip + 14)
  if (reach <= 0) return { x: 1, y: 0 }
  if (atStart) return normalize(pts[reach].x - pts[skip].x, pts[reach].y - pts[skip].y)
  const i = pts.length - 1
  return normalize(pts[i - reach].x - pts[i - skip].x, pts[i - reach].y - pts[i - skip].y)
}

type Port = { edge: number; atStart: boolean; tx: number; ty: number }

/**
 * 在每个结点上，把走向最一致的两条链配成一对（近似直线穿过）。
 * 直角拐弯不会被接上，留给后续「一笔跨多段」去匹配。
 */
function linkThroughJunctions(edges: Edge[]): Array<{ points: Point[]; closed: boolean }> {
  const groups = new Map<string, Port[]>()
  const addPort = (edge: number, atStart: boolean) => {
    const pts = edges[edge].points
    const p = atStart ? pts[0] : pts[pts.length - 1]
    const key = `${p.x},${p.y}`
    const tan = portTangent(pts, atStart)
    const list = groups.get(key) ?? []
    list.push({ edge, atStart, tx: tan.x, ty: tan.y })
    groups.set(key, list)
  }
  for (let i = 0; i < edges.length; i++) {
    addPort(i, true)
    addPort(i, false)
  }

  const partner = new Map<string, { edge: number; atStart: boolean }>()
  const portKey = (edge: number, atStart: boolean) => `${edge}:${atStart ? 0 : 1}`

  for (const ports of groups.values()) {
    if (ports.length < 2) continue
    const pairs: Array<{ i: number; j: number; score: number }> = []
    for (let i = 0; i < ports.length; i++) {
      for (let j = i + 1; j < ports.length; j++) {
        // 两条向外切线越相反，转角越小。score = cos(转角)
        const score = -(ports[i].tx * ports[j].tx + ports[i].ty * ports[j].ty)
        pairs.push({ i, j, score })
      }
    }
    pairs.sort((a, b) => b.score - a.score)
    const taken = new Set<number>()
    for (const pair of pairs) {
      // 大约 62° 以内视为同一条平滑轮廓。直角仍保持断开。
      if (pair.score < 0.47) break
      if (taken.has(pair.i) || taken.has(pair.j)) continue
      taken.add(pair.i)
      taken.add(pair.j)
      const a = ports[pair.i]
      const b = ports[pair.j]
      partner.set(portKey(a.edge, a.atStart), { edge: b.edge, atStart: b.atStart })
      partner.set(portKey(b.edge, b.atStart), { edge: a.edge, atStart: a.atStart })
    }
  }

  const visited = new Set<number>()
  const paths: Array<{ points: Point[]; closed: boolean }> = []

  const sequenceOf = (edge: number, enterAtStart: boolean) => {
    const pts = edges[edge].points
    return enterAtStart ? pts : [...pts].reverse()
  }

  for (let seed = 0; seed < edges.length; seed++) {
    if (visited.has(seed)) continue
    visited.add(seed)
    const seq: Array<{ edge: number; enterAtStart: boolean }> = [
      { edge: seed, enterAtStart: true },
    ]

    let guard = 0
    while (guard++ < edges.length + 2) {
      const first = seq[0]
      const prev = partner.get(portKey(first.edge, first.enterAtStart))
      if (!prev) break
      if (prev.edge === seed || seq.some((s) => s.edge === prev.edge)) break
      visited.add(prev.edge)
      seq.unshift({ edge: prev.edge, enterAtStart: !prev.atStart })
    }

    let closed = false
    guard = 0
    while (guard++ < edges.length + 2) {
      const last = seq[seq.length - 1]
      const next = partner.get(portKey(last.edge, !last.enterAtStart))
      if (!next) break
      if (next.edge === seq[0].edge) {
        closed = true
        break
      }
      if (seq.some((s) => s.edge === next.edge)) break
      visited.add(next.edge)
      seq.push({ edge: next.edge, enterAtStart: next.atStart })
    }

    const points: Point[] = []
    for (const item of seq) {
      const pts = sequenceOf(item.edge, item.enterAtStart)
      const start = points.length === 0 ? 0 : 1
      for (let i = start; i < pts.length; i++) points.push(pts[i])
    }
    if (closed && points.length > 2) {
      const a = points[0]
      const b = points[points.length - 1]
      if (Math.hypot(a.x - b.x, a.y - b.y) <= 1.2) points.pop()
    }
    if (points.length >= 2) paths.push({ points, closed })
  }
  return paths
}

function outwardTangent(pts: Point[], atStart: boolean): Point {
  const skip = Math.min(4, Math.max(0, Math.floor((pts.length - 1) / 5)))
  const reach = Math.min(pts.length - 1, skip + 12)
  if (reach <= 0) return { x: 1, y: 0 }
  if (atStart) return normalize(pts[skip].x - pts[reach].x, pts[skip].y - pts[reach].y)
  const i = pts.length - 1
  return normalize(pts[i - skip].x - pts[i - reach].x, pts[i - skip].y - pts[i - reach].y)
}

/**
 * 把端点之间的小缺口接上：缺口方向要和两端切线一致，
 * 避免把平行线或直角拐角硬焊在一起。
 */
function bridgeGaps(paths: Array<{ points: Point[]; closed: boolean }>) {
  const GAP = 18
  let guard = 0
  while (guard++ < paths.length + 4) {
    type End = {
      pi: number
      atStart: boolean
      x: number
      y: number
      tx: number
      ty: number
    }
    const ends: End[] = []
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]
      if (!p || p.closed || p.points.length < 2) continue
      const a = outwardTangent(p.points, true)
      const b = outwardTangent(p.points, false)
      ends.push({
        pi: i,
        atStart: true,
        x: p.points[0].x,
        y: p.points[0].y,
        tx: a.x,
        ty: a.y,
      })
      const last = p.points[p.points.length - 1]
      ends.push({
        pi: i,
        atStart: false,
        x: last.x,
        y: last.y,
        tx: b.x,
        ty: b.y,
      })
    }

    let best = -1e9
    let bi = -1
    let bj = -1
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const A = ends[i]
        const B = ends[j]
        if (A.pi === B.pi && A.atStart === B.atStart) continue
        const dx = B.x - A.x
        const dy = B.y - A.y
        const d = Math.hypot(dx, dy)
        if (d > GAP || d < 0.6) continue
        if (A.pi === B.pi) {
          const len = arcLength(paths[A.pi].points)
          if (d > Math.min(18, len * 0.4)) continue
        }
        const gx = dx / d
        const gy = dy / d
        const alignA = A.tx * gx + A.ty * gy
        const alignB = B.tx * -gx + B.ty * -gy
        let minAlign = 0.84
        if (d <= 5) minAlign = 0.2
        else if (d <= 9) minAlign = 0.55
        else if (d <= 14) minAlign = 0.72
        if (alignA < minAlign || alignB < minAlign) continue
        const score = alignA + alignB - d / GAP
        if (score > best) {
          best = score
          bi = i
          bj = j
        }
      }
    }
    if (bi < 0) break

    const A = ends[bi]
    const B = ends[bj]
    if (A.pi === B.pi) {
      paths[A.pi].closed = true
      continue
    }

    let aPts = paths[A.pi].points.slice()
    if (A.atStart) aPts.reverse()
    let bPts = paths[B.pi].points.slice()
    if (!B.atStart) bPts.reverse()
    const gap = Math.hypot(
      aPts[aPts.length - 1].x - bPts[0].x,
      aPts[aPts.length - 1].y - bPts[0].y,
    )
    const merged = aPts.concat(gap < 1.2 ? bPts.slice(1) : bPts)
    const keep = Math.min(A.pi, B.pi)
    const drop = Math.max(A.pi, B.pi)
    paths[keep] = { points: merged, closed: false }
    paths.splice(drop, 1)
  }
}

function polishPath(points: Point[], closed: boolean): Point[] {
  const simplified = closed ? simplifyClosed(points, 1.2) : simplifyOpen(points, 1.2)
  if (simplified.length < 2) return dedupePoints(points)
  const smooth = smoothPolyline(simplified, closed, 2)
  const sampled = resampleSpacing(smooth, 2.25, closed)
  return dedupePoints(sampled)
}

/**
 * 骨架 → 长折线。
 * 先按结点拆开，再沿最顺的方向穿过分叉，并补上小缺口，最后简化、平滑。
 */
export function traceContours(
  skel: Uint8Array,
  width: number,
  height: number,
): Contour[] {
  removeSmallComponents(skel, width, height, 12)
  collapseSquares(skel, width, height)
  // 只剪很短的骨架毛刺。再长一点的分叉留给「穿过分叉」去决定要不要接上
  pruneSpurs(skel, width, height, 8)

  const { edges, loops } = traceAtomicEdges(skel, width, height)
  const paths = linkThroughJunctions(edges)
  for (const loop of loops) paths.push({ points: loop, closed: true })
  bridgeGaps(paths)

  const contours: Contour[] = []
  for (const path of paths) {
    const len = arcLength(path.points)
    const minLen = path.closed ? 18 : 12
    if (len < minLen || path.points.length < 2) continue
    const points = polishPath(path.points, path.closed)
    if (points.length < 2 || arcLength(points) < minLen) continue
    contours.push({ id: contours.length, points, closed: path.closed })
  }
  return contours
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
  const buckets: SpatialIndex['buckets'] = Array.from({ length: cols * rows }, () => [])
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

/** 半径内每条轮廓只保留最近点 */
export function queryHits(
  x: number,
  y: number,
  radius: number,
  contours: Contour[],
  index: SpatialIndex,
): NearestHit[] {
  const r = radius
  const minX = Math.max(0, Math.floor((x - r) / index.cell))
  const maxX = Math.min(index.cols - 1, Math.floor((x + r) / index.cell))
  const minY = Math.max(0, Math.floor((y - r) / index.cell))
  const maxY = Math.min(index.rows - 1, Math.floor((y + r) / index.cell))
  const best = new Map<number, NearestHit>()
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

export function contourTangent(contour: Contour, index: number): Point {
  const pts = contour.points
  const n = pts.length
  if (n < 2) return { x: 1, y: 0 }
  const i = ((index % n) + n) % n
  const i0 = contour.closed ? (i - 3 + n) % n : Math.max(0, i - 3)
  const i1 = contour.closed ? (i + 3) % n : Math.min(n - 1, i + 3)
  return normalize(pts[i1].x - pts[i0].x, pts[i1].y - pts[i0].y)
}

function mod(i: number, n: number) {
  return ((i % n) + n) % n
}

/** 沿轮廓从起点下标走到终点下标（下标可以是展开后的实数） */
export function sliceContour(contour: Contour, startU: number, endU: number): Point[] {
  const pts = contour.points
  const n = pts.length
  if (n === 0) return []
  if (n === 1) return [{ ...pts[0] }]
  const span = endU - startU
  const dir = span >= 0 ? 1 : -1
  const steps = Math.min(n, Math.max(0, Math.round(Math.abs(span))))
  const out: Point[] = []
  let i = mod(Math.round(startU), n)
  for (let s = 0; s <= steps; s++) {
    out.push(pts[i])
    if (!contour.closed && (i + dir < 0 || i + dir >= n)) break
    i = mod(i + dir, n)
    if (contour.closed && s > 0 && steps >= n && i === mod(Math.round(startU), n)) break
  }
  return dedupePoints(out, 0.2)
}

/** 下标走到轮廓任一端点的弧长，闭合轮廓没有端点 */
export function distanceToOpenEnd(contour: Contour, index: number) {
  if (contour.closed) return Number.POSITIVE_INFINITY
  const pts = contour.points
  const i = Math.max(0, Math.min(pts.length - 1, Math.round(index)))
  let d0 = 0
  for (let k = i; k > 0; k--) {
    d0 += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
    if (d0 > 48) break
  }
  let d1 = 0
  for (let k = i; k < pts.length - 1; k++) {
    d1 += Math.hypot(pts[k].x - pts[k + 1].x, pts[k].y - pts[k + 1].y)
    if (d1 > 48) break
  }
  return Math.min(d0, d1)
}
