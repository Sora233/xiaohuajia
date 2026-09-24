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

/** Zhang-Suen 细化，得到单像素骨架。只扫前景像素，最多 72 轮。 */
export function thinSkeleton(
  src: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const img = new Uint8Array(src)
  let pixels: number[] = []
  for (let i = 0; i < img.length; i++) if (img[i]) pixels.push(i)
  let changed = true
  let guard = 0

  while (changed && pixels.length > 0 && guard++ < 72) {
    changed = false
    for (const step of [1, 2] as const) {
      const kill: number[] = []
      for (const i of pixels) {
        if (!img[i]) continue
        const x = i % width
        const y = (i - x) / width
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue
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
        kill.push(i)
      }
      if (kill.length === 0) continue
      changed = true
      for (const i of kill) img[i] = 0
      const next: number[] = []
      for (const i of pixels) if (img[i]) next.push(i)
      pixels = next
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

/** 无向边的整数键。工作图最长边有上限，乘积落在安全整数里。 */
function bondId(x1: number, y1: number, x2: number, y2: number, width: number) {
  let a = y1 * width + x1
  let b = y2 * width + x2
  if (a > b) {
    const t = a
    a = b
    b = t
  }
  return a * 0x200000 + b
}

/** 在分叉处断开，抽出端点/结点之间的原子链，环单独成链 */
function traceAtomicEdges(
  skel: Uint8Array,
  width: number,
  height: number,
): { edges: Edge[]; loops: Point[][] } {
  const degAt = (x: number, y: number) => neighborCount(skel, x, y, width, height)
  const used = new Set<number>()
  const edges: Edge[] = []
  const loops: Point[][] = []

  const walk = (sx: number, sy: number, nx: number, ny: number): Point[] => {
    const pts: Point[] = [
      { x: sx, y: sy },
      { x: nx, y: ny },
    ]
    used.add(bondId(sx, sy, nx, ny, width))
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
      if (used.has(bondId(cx, cy, nx2, ny2, width))) break
      used.add(bondId(cx, cy, nx2, ny2, width))
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
      if (used.has(bondId(x, y, nx, ny, width))) continue
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
 * 在每个结点上，把转角能接上的分支配成一对。
 * 直线优先；直角拐弯也接上，这样窗框、桌沿会是一整条。
 * 掉头（大约超过 105°）仍然断开，避免把毛刺焊进主线。
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
        // 两条向外切线越相反，转角越小。turn = cos(转角)
        const turn = -(ports[i].tx * ports[j].tx + ports[i].ty * ports[j].ty)
        // 大约超过 105° 的掉头不接，避免毛刺焊进主线
        if (turn < -0.25) continue
        const lenA = edges[ports[i].edge].points.length
        const lenB = edges[ports[j].edge].points.length
        // 长边优先接在一起。短而更直的分叉让路，猫背、窗框才不会被腿或窗棱拆开
        const score = turn * Math.sqrt(Math.min(lenA, lenB))
        pairs.push({ i, j, score })
      }
    }
    pairs.sort((a, b) => b.score - a.score)
    const taken = new Set<number>()
    for (const pair of pairs) {
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
    // left 从种子向前倒着长，最后再反转，避免 unshift 变成二次成本
    const left: Array<{ edge: number; enterAtStart: boolean }> = []
    const right: Array<{ edge: number; enterAtStart: boolean }> = [
      { edge: seed, enterAtStart: true },
    ]
    const inSeq = new Set<number>([seed])
    const limit = edges.length + 2

    let guard = 0
    while (guard++ < limit) {
      const first = left.length > 0 ? left[left.length - 1] : right[0]
      const prev = partner.get(portKey(first.edge, first.enterAtStart))
      if (!prev || inSeq.has(prev.edge)) break
      visited.add(prev.edge)
      inSeq.add(prev.edge)
      left.push({ edge: prev.edge, enterAtStart: !prev.atStart })
    }

    let closed = false
    guard = 0
    while (guard++ < limit) {
      const last = right[right.length - 1]
      const next = partner.get(portKey(last.edge, !last.enterAtStart))
      if (!next) break
      const headEdge = left.length > 0 ? left[left.length - 1].edge : right[0].edge
      if (next.edge === headEdge) {
        closed = true
        break
      }
      if (inSeq.has(next.edge)) break
      visited.add(next.edge)
      inSeq.add(next.edge)
      right.push({ edge: next.edge, enterAtStart: next.atStart })
    }

    const seq = left.length > 0 ? left.reverse().concat(right) : right

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

type GapEnd = {
  pi: number
  atStart: boolean
  x: number
  y: number
  tx: number
  ty: number
}

/**
 * 端点之间能不能接成一条。
 * 贴得很近的断口，共线或直角都接（窗框被骨架拆开时，两端常常背对背）。
 * 稍远的缺口允许拐角；再远只接几乎共线的，避免把内外框或平行线焊在一起。
 * 掉头（大约超过 105°）不接。
 */
function gapScore(paths: Array<{ points: Point[]; closed: boolean }>, A: GapEnd, B: GapEnd) {
  if (A.pi === B.pi && A.atStart === B.atStart) return null
  const dx = B.x - A.x
  const dy = B.y - A.y
  const d = Math.hypot(dx, dy)
  if (d > 32 || d < 0.6) return null
  if (A.pi === B.pi) {
    const len = arcLength(paths[A.pi].points)
    if (d > Math.min(24, len * 0.45)) return null
  }
  const gx = dx / d
  const gy = dy / d
  const alignA = A.tx * gx + A.ty * gy
  const alignB = B.tx * -gx + B.ty * -gy
  // 1 是直线，0 是直角，-1 是掉头
  const turn = -(A.tx * B.tx + A.ty * B.ty)
  if (turn < -0.25) return null
  if (d > 18) {
    if (turn < 0.9 || alignA < 0.88 || alignB < 0.88) return null
  } else if (d > 4.5) {
    // 直角缺口的方向大约是 0.7；明显落在背后的不接
    if (alignA < 0.2 || alignB < 0.2) return null
  }
  return turn * 3 + alignA + alignB - d / 20
}

/**
 * 把端点之间的小缺口接上。
 * 用网格只比较相邻格子里的端点，每轮把互不冲突的缺口一起接上。
 * 轮数有硬上限，路径数只减不增，不会在主线程上做全对全扫描。
 */
function bridgeGaps(paths: Array<{ points: Point[]; closed: boolean }>) {
  const CELL = 32
  const MAX_PASSES = 16
  const NEIGHBOR_CAP = 96

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const ends: GapEnd[] = []
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
    if (ends.length < 2) break

    const buckets = new Map<string, number[]>()
    for (let i = 0; i < ends.length; i++) {
      const key = `${Math.floor(ends[i].x / CELL)},${Math.floor(ends[i].y / CELL)}`
      const list = buckets.get(key)
      if (list) list.push(i)
      else buckets.set(key, [i])
    }

    const cands: Array<{ i: number; j: number; score: number }> = []
    for (let i = 0; i < ends.length; i++) {
      const A = ends[i]
      const cx = Math.floor(A.x / CELL)
      const cy = Math.floor(A.y / CELL)
      const nearby: number[] = []
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = buckets.get(`${cx + ox},${cy + oy}`)
          if (!list) continue
          for (const j of list) if (j > i) nearby.push(j)
        }
      }
      if (nearby.length > NEIGHBOR_CAP) {
        nearby.sort((a, b) => {
          const pa = ends[a]
          const pb = ends[b]
          const da = (pa.x - A.x) ** 2 + (pa.y - A.y) ** 2
          const db = (pb.x - A.x) ** 2 + (pb.y - A.y) ** 2
          return da - db
        })
        nearby.length = NEIGHBOR_CAP
      }
      for (const j of nearby) {
        const score = gapScore(paths, A, ends[j])
        if (score === null) continue
        cands.push({ i, j, score })
      }
    }
    if (cands.length === 0) break
    cands.sort((a, b) => b.score - a.score)

    const usedEnd = new Uint8Array(ends.length)
    const pathUsed = new Uint8Array(paths.length)
    const closings: number[] = []
    const merges: Array<{ i: number; j: number }> = []
    for (const cand of cands) {
      if (usedEnd[cand.i] || usedEnd[cand.j]) continue
      const A = ends[cand.i]
      const B = ends[cand.j]
      if (pathUsed[A.pi] || (A.pi !== B.pi && pathUsed[B.pi])) continue
      usedEnd[cand.i] = 1
      usedEnd[cand.j] = 1
      pathUsed[A.pi] = 1
      if (A.pi !== B.pi) pathUsed[B.pi] = 1
      if (A.pi === B.pi) closings.push(A.pi)
      else merges.push({ i: cand.i, j: cand.j })
    }
    if (closings.length === 0 && merges.length === 0) break

    for (const pi of closings) paths[pi].closed = true
    const drop = new Set<number>()
    for (const merge of merges) {
      const A = ends[merge.i]
      const B = ends[merge.j]
      if (drop.has(A.pi) || drop.has(B.pi)) continue
      const aPts = paths[A.pi].points.slice()
      if (A.atStart) aPts.reverse()
      const bPts = paths[B.pi].points.slice()
      if (!B.atStart) bPts.reverse()
      const gap = Math.hypot(
        aPts[aPts.length - 1].x - bPts[0].x,
        aPts[aPts.length - 1].y - bPts[0].y,
      )
      const merged = aPts.concat(gap < 1.2 ? bPts.slice(1) : bPts)
      const keep = Math.min(A.pi, B.pi)
      const lose = Math.max(A.pi, B.pi)
      paths[keep] = { points: merged, closed: false }
      drop.add(lose)
    }
    if (drop.size > 0) {
      const next = []
      for (let i = 0; i < paths.length; i++) if (!drop.has(i)) next.push(paths[i])
      paths.length = 0
      for (const path of next) paths.push(path)
    }
  }
}

/**
 * 细化后偶发留下并排的两条骨架。较短、并且绝大部分点都贴着另一条的，丢掉。
 * 只看彼此贴得很近的点，窗框的内外两圈（大约十几像素）不会被当成重影。
 */
function dropNearDuplicates(paths: Array<{ points: Point[]; closed: boolean }>) {
  const CELL = 4
  const NEAR = 2.6
  const near2 = NEAR * NEAR
  type Rec = { pi: number; x: number; y: number }
  const buckets = new Map<string, Rec[]>()
  const lens = new Array<number>(paths.length)
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]
    lens[pi] = path.points.length < 2 ? 0 : arcLength(path.points)
    if (path.closed || path.points.length < 2) continue
    const step = Math.max(1, Math.floor(path.points.length / 64))
    for (let i = 0; i < path.points.length; i += step) {
      const pt = path.points[i]
      const key = `${Math.floor(pt.x / CELL)},${Math.floor(pt.y / CELL)}`
      const rec = { pi, x: pt.x, y: pt.y }
      const list = buckets.get(key)
      if (list) list.push(rec)
      else buckets.set(key, [rec])
    }
  }

  const drop = new Set<number>()
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]
    if (path.closed || drop.has(pi) || path.points.length < 8) continue
    const step = Math.max(1, Math.floor(path.points.length / 28))
    const votes = new Map<number, number>()
    let samples = 0
    let near = 0
    for (let i = 0; i < path.points.length; i += step) {
      samples++
      const pt = path.points[i]
      const cx = Math.floor(pt.x / CELL)
      const cy = Math.floor(pt.y / CELL)
      let bestPi = -1
      let bestD = near2
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = buckets.get(`${cx + ox},${cy + oy}`)
          if (!list) continue
          const limit = Math.min(list.length, 24)
          for (let k = 0; k < limit; k++) {
            const rec = list[k]
            if (rec.pi === pi || drop.has(rec.pi)) continue
            const d2 = (rec.x - pt.x) ** 2 + (rec.y - pt.y) ** 2
            if (d2 < bestD) {
              bestD = d2
              bestPi = rec.pi
            }
          }
        }
      }
      if (bestPi >= 0) {
        near++
        votes.set(bestPi, (votes.get(bestPi) ?? 0) + 1)
      }
    }
    if (samples < 6 || near / samples < 0.72) continue
    let winner = -1
    let winnerN = 0
    for (const [id, n] of votes) {
      if (n > winnerN) {
        winnerN = n
        winner = id
      }
    }
    if (winner < 0 || winnerN / samples < 0.6) continue
    if (lens[pi] <= lens[winner]) drop.add(pi)
    else drop.add(winner)
  }
  if (drop.size === 0) return
  const next = []
  for (let i = 0; i < paths.length; i++) if (!drop.has(i)) next.push(paths[i])
  paths.length = 0
  for (const path of next) paths.push(path)
}

function localTangent(pts: Point[], index: number): Point {
  const i0 = Math.max(0, index - 4)
  const i1 = Math.min(pts.length - 1, index + 4)
  if (i1 === i0) return { x: 1, y: 0 }
  return normalize(pts[i1].x - pts[i0].x, pts[i1].y - pts[i0].y)
}

/**
 * 两条线有一段贴在一起、又各自多出一截时，把多出来的接上，合成一条更长的轮廓。
 * 只接走向一致的重叠，窗棱搭在窗框上（方向垂直）不会被焊进去。
 */
function graftOverlaps(paths: Array<{ points: Point[]; closed: boolean }>) {
  const CELL = 6
  const NEAR = 6
  const near2 = NEAR * NEAR
  const MAX_PASSES = 8

  const nearestOn = (
    buckets: Map<string, Array<{ pi: number; i: number; x: number; y: number }>>,
    pi: number,
    x: number,
    y: number,
    hostFilter: number,
  ) => {
    const cx = Math.floor(x / CELL)
    const cy = Math.floor(y / CELL)
    let bestI = -1
    let bestD = near2
    let bestPi = -1
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = buckets.get(`${cx + ox},${cy + oy}`)
        if (!list) continue
        const n = Math.min(list.length, 28)
        for (let k = 0; k < n; k++) {
          const rec = list[k]
          if (rec.pi === pi) continue
          if (hostFilter >= 0 && rec.pi !== hostFilter) continue
          const d2 = (rec.x - x) ** 2 + (rec.y - y) ** 2
          if (d2 < bestD) {
            bestD = d2
            bestI = rec.i
            bestPi = rec.pi
          }
        }
      }
    }
    return bestPi < 0 ? null : { pi: bestPi, i: bestI }
  }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const buckets = new Map<string, Array<{ pi: number; i: number; x: number; y: number }>>()
    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi]
      if (!path || path.closed || path.points.length < 2) continue
      const step = path.points.length > 240 ? 2 : 1
      for (let i = 0; i < path.points.length; i += step) {
        const pt = path.points[i]
        const key = `${Math.floor(pt.x / CELL)},${Math.floor(pt.y / CELL)}`
        const rec = { pi, i, x: pt.x, y: pt.y }
        const list = buckets.get(key)
        if (list) list.push(rec)
        else buckets.set(key, [rec])
      }
    }

    const drop = new Set<number>()
    const touched = new Set<number>()
    let changed = false
    for (let gi = 0; gi < paths.length; gi++) {
      if (drop.has(gi)) continue
      const guest = paths[gi]
      if (!guest || guest.closed || guest.points.length < 10) continue

      let best: {
        host: number
        overhang: number
        atStart: boolean
        split: number
        hostIdx: number
      } | null = null

      for (const atStart of [true, false]) {
        let host = -1
        let overlap = 0
        let split = atStart ? 0 : guest.points.length - 1
        let hostIdx = -1
        const limit = guest.points.length
        for (let s = 0; s < limit; s++) {
          const idx = atStart ? s : guest.points.length - 1 - s
          const pt = guest.points[idx]
          const hit = nearestOn(buckets, gi, pt.x, pt.y, host)
          if (!hit) {
            if (overlap >= 4) break
            continue
          }
          if (host < 0) host = hit.pi
          if (hit.pi !== host || drop.has(host)) {
            if (overlap >= 4) break
            continue
          }
          overlap++
          split = idx
          hostIdx = hit.i
        }
        if (host < 0 || overlap < 4 || drop.has(host) || touched.has(host)) continue
        const overhang = atStart ? guest.points.length - 1 - split : split
        if (overhang < 12) continue
        if (!best || overhang > best.overhang) {
          best = { host, overhang, atStart, split, hostIdx }
        }
      }
      if (!best) continue

      const hostPath = paths[best.host]
      if (!hostPath || hostPath.closed || hostPath.points.length < 2 || touched.has(best.host)) continue
      if (best.hostIdx < 0 || best.hostIdx >= hostPath.points.length) continue
      if (best.split < 0 || best.split >= guest.points.length) continue
      const gt = localTangent(guest.points, best.split)
      const ht = localTangent(hostPath.points, best.hostIdx)
      if (Math.abs(gt.x * ht.x + gt.y * ht.y) < 0.72) continue

      const overhangPts = best.atStart
        ? guest.points.slice(best.split)
        : guest.points.slice(0, best.split + 1)
      // 重叠落在宿主一端就直接接上；落在中间就把宿主切开，只把伸出的那段接到切点上
      const dStart = Math.hypot(
        hostPath.points[best.hostIdx].x - hostPath.points[0].x,
        hostPath.points[best.hostIdx].y - hostPath.points[0].y,
      )
      const dEnd = Math.hypot(
        hostPath.points[best.hostIdx].x - hostPath.points[hostPath.points.length - 1].x,
        hostPath.points[best.hostIdx].y - hostPath.points[hostPath.points.length - 1].y,
      )
      const nearStart = best.hostIdx <= 8 || dStart < 16
      const nearEnd = best.hostIdx >= hostPath.points.length - 9 || dEnd < 16
      let hostAtEnd = dEnd <= dStart
      if (nearStart && !nearEnd) hostAtEnd = false
      if (nearEnd && !nearStart) hostAtEnd = true

      const boundaryFirst = best.atStart
      let extra = overhangPts.map((p) => ({ ...p }))
      // 接到宿主末尾时，伸出段的接缝要放在开头；接到宿主开头时，接缝要放在末尾
      if (hostAtEnd !== boundaryFirst) extra.reverse()
      const hostPts = hostPath.points
      let merged: Point[]
      if (hostAtEnd) {
        const gap = Math.hypot(
          hostPts[hostPts.length - 1].x - extra[0].x,
          hostPts[hostPts.length - 1].y - extra[0].y,
        )
        merged = hostPts.concat(gap < 1.2 ? extra.slice(1) : extra)
      } else {
        const gap = Math.hypot(extra[extra.length - 1].x - hostPts[0].x, extra[extra.length - 1].y - hostPts[0].y)
        merged = (gap < 1.2 ? extra.slice(0, -1) : extra).concat(hostPts)
      }
      if (arcLength(merged) < arcLength(hostPts) + 10) continue
      // 切在中间时，宿主没被接上的那一半若不是重影就留着
      if (!nearStart && !nearEnd) {
        const keepFrom = hostAtEnd ? 0 : best.hostIdx
        const keepTo = hostAtEnd ? best.hostIdx : hostPts.length - 1
        const rest = hostPts.slice(keepFrom, keepTo + 1).map((p) => ({ ...p }))
        if (rest.length >= 8 && arcLength(rest) > 16) {
          paths.push({ points: rest, closed: false })
        }
        const taken = hostAtEnd ? hostPts.slice(best.hostIdx) : hostPts.slice(0, best.hostIdx + 1)
        if (hostAtEnd) {
          const gap = Math.hypot(taken[taken.length - 1].x - extra[0].x, taken[taken.length - 1].y - extra[0].y)
          merged = taken.concat(gap < 1.2 ? extra.slice(1) : extra)
        } else {
          const gap = Math.hypot(
            extra[extra.length - 1].x - taken[0].x,
            extra[extra.length - 1].y - taken[0].y,
          )
          merged = (gap < 1.2 ? extra.slice(0, -1) : extra).concat(taken)
        }
      }
      paths[best.host] = { points: merged, closed: false }
      drop.add(gi)
      touched.add(best.host)
      changed = true
    }
    if (!changed) break
    if (drop.size > 0) {
      const next = []
      for (let i = 0; i < paths.length; i++) if (!drop.has(i)) next.push(paths[i])
      paths.length = 0
      for (const path of next) paths.push(path)
    }
  }
}

function polishPath(points: Point[], closed: boolean): Point[] {
  const simplified = closed ? simplifyClosed(points, 1.2) : simplifyOpen(points, 1.2)
  if (simplified.length < 2) return dedupePoints(points)
  const smooth = smoothPolyline(simplified, closed, 2)
  const sampled = resampleSpacing(smooth, 2.25, closed)
  return dedupePoints(sampled)
}

export type TraceTimings = {
  removeSmall: number
  collapse: number
  prune: number
  atomic: number
  link: number
  bridge: number
  polish: number
  edges: number
  paths: number
  contours: number
}

/** 最近一次 traceContours 的分阶段耗时，便于发现主线程回归 */
let lastTraceTimings: TraceTimings | null = null

export function takeTraceTimings(): TraceTimings | null {
  return lastTraceTimings
}

function lap(t0: number) {
  return Math.round((performance.now() - t0) * 10) / 10
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
  const timings = {} as TraceTimings
  let t = performance.now()
  removeSmallComponents(skel, width, height, 12)
  timings.removeSmall = lap(t)
  t = performance.now()
  collapseSquares(skel, width, height)
  timings.collapse = lap(t)
  t = performance.now()
  // 只剪很短的骨架毛刺。再长一点的分叉留给「穿过分叉」去决定要不要接上
  pruneSpurs(skel, width, height, 8)
  timings.prune = lap(t)

  t = performance.now()
  const { edges, loops } = traceAtomicEdges(skel, width, height)
  timings.atomic = lap(t)
  timings.edges = edges.length

  t = performance.now()
  const paths = linkThroughJunctions(edges)
  timings.link = lap(t)
  for (const loop of loops) paths.push({ points: loop, closed: true })
  dropNearDuplicates(paths)

  t = performance.now()
  bridgeGaps(paths)
  graftOverlaps(paths)
  timings.bridge = lap(t)
  timings.paths = paths.length

  t = performance.now()
  const contours: Contour[] = []
  for (const path of paths) {
    const len = arcLength(path.points)
    const minLen = path.closed ? 18 : 12
    if (len < minLen || path.points.length < 2) continue
    const points = polishPath(path.points, path.closed)
    if (points.length < 2 || arcLength(points) < minLen) continue
    contours.push({ id: contours.length, points, closed: path.closed })
  }
  timings.polish = lap(t)
  timings.contours = contours.length
  lastTraceTimings = timings
  console.info(
    `[小画家] 轮廓 ${width}x${height} 边${timings.edges} 路径${timings.paths} 轮廓${timings.contours} ` +
      `去碎${timings.removeSmall}ms 方块${timings.collapse}ms 毛刺${timings.prune}ms ` +
      `抽链${timings.atomic}ms 穿叉${timings.link}ms 补缺${timings.bridge}ms 平滑${timings.polish}ms`,
  )
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
