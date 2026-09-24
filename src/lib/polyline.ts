export type Point = { x: number; y: number }

export function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function arcLength(pts: Point[]) {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i])
  return s
}

export function normalize(x: number, y: number): Point {
  const l = Math.hypot(x, y) || 1
  return { x: x / l, y: y / l }
}

/** 缓入缓出，抬笔后的变形用 */
export function easeInOutCubic(t: number) {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}

export function pointAtArc(pts: Point[], target: number): Point {
  if (pts.length === 0) return { x: 0, y: 0 }
  if (pts.length === 1 || target <= 0) return { ...pts[0] }
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i])
    if (acc + L >= target || i === pts.length - 1) {
      const t = L < 1e-6 ? 0 : Math.min(1, (target - acc) / L)
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      }
    }
    acc += L
  }
  return { ...pts[pts.length - 1] }
}

/** 按弧长取恰好 count 个点，含首尾 */
export function resampleCount(pts: Point[], count: number): Point[] {
  if (pts.length === 0 || count <= 0) return []
  if (count === 1 || pts.length === 1) return [{ ...pts[0] }]
  const total = arcLength(pts)
  if (total < 1e-4) return Array.from({ length: count }, () => ({ ...pts[0] }))
  const out: Point[] = []
  for (let i = 0; i < count; i++) {
    out.push(pointAtArc(pts, (total * i) / (count - 1)))
  }
  out[0] = { ...pts[0] }
  out[count - 1] = { ...pts[pts.length - 1] }
  return out
}

/**
 * 按大致间距重采样。
 * 闭合折线沿环绕一周均匀取点，不重复起点。
 */
export function resampleSpacing(pts: Point[], spacing: number, closed = false): Point[] {
  if (pts.length === 0) return []
  if (pts.length === 1) return [{ ...pts[0] }]
  const loop = closed ? [...pts, pts[0]] : pts
  const total = arcLength(loop)
  const step = Math.max(0.5, spacing)
  if (total < step) {
    return closed
      ? pts.map((p) => ({ ...p }))
      : [{ ...pts[0] }, { ...pts[pts.length - 1] }]
  }
  const n = Math.max(closed ? 4 : 2, Math.round(total / step))
  if (!closed) return resampleCount(pts, n + 1)
  const out: Point[] = []
  for (let i = 0; i < n; i++) out.push(pointAtArc(loop, (total * i) / n))
  return out
}

/** 截取折线弧长比例 [f0, f1] 的那一段 */
export function slicePolylineByFraction(pts: Point[], f0: number, f1: number): Point[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }))
  const total = arcLength(pts)
  if (total < 1e-4) return pts.map((p) => ({ ...p }))
  const a = Math.min(f0, f1)
  const b = Math.max(f0, f1)
  const start = Math.max(0, Math.min(1, a)) * total
  const end = Math.max(0, Math.min(1, b)) * total
  if (end - start < 0.5) {
    const p = pointAtArc(pts, start)
    return [p, { ...p }]
  }
  const out: Point[] = [pointAtArc(pts, start)]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i])
    const next = acc + L
    if (next > start + 0.01 && acc < end - 0.01 && next < end) out.push({ ...pts[i] })
    acc = next
  }
  out.push(pointAtArc(pts, end))
  return dedupePoints(out)
}

export function dedupePoints(pts: Point[], minDist = 0.35): Point[] {
  if (pts.length === 0) return []
  const out: Point[] = [{ ...pts[0] }]
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) >= minDist) out.push({ ...pts[i] })
  }
  if (out.length === 1 && pts.length > 1) out.push({ ...pts[pts.length - 1] })
  return out
}

/** 让目标折线的走向跟源折线一致（必要时整段反向） */
export function orientPolyline(src: Point[], dst: Point[]): Point[] {
  if (dst.length < 2 || src.length < 2) return dst.map((p) => ({ ...p }))
  const s0 = src[0]
  const s1 = src[src.length - 1]
  const d0 = dst[0]
  const d1 = dst[dst.length - 1]
  const forward = dist(s0, d0) + dist(s1, d1)
  const backward = dist(s0, d1) + dist(s1, d0)
  const ordered = backward + 0.75 < forward ? [...dst].reverse() : dst
  return ordered.map((p) => ({ ...p }))
}

/** 弧长对应的点对点插值。eased 为已经缓动过的 0–1 */
export function morphPolyline(src: Point[], dst: Point[], eased: number): Point[] {
  if (src.length < 2) return src.map((p) => ({ ...p }))
  if (dst.length < 2) return src.map((p) => ({ ...p }))
  const n = Math.max(
    12,
    Math.min(96, Math.round(Math.max(arcLength(src), arcLength(dst)) / 5)),
  )
  const a = resampleCount(src, n)
  const b = resampleCount(orientPolyline(a, dst), n)
  const t = Math.min(1, Math.max(0, eased))
  const out: Point[] = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = {
      x: a[i].x + (b[i].x - a[i].x) * t,
      y: a[i].y + (b[i].y - a[i].y) * t,
    }
  }
  return out
}

function perpDist(p: Point, a: Point, b: Point) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const ab2 = abx * abx + aby * aby
  if (ab2 < 1e-8) return dist(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2))
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

/** 迭代版 Douglas-Peucker，避免长骨架递归过深 */
export function simplifyOpen(pts: Point[], epsilon: number): Point[] {
  if (pts.length < 3) return pts.map((p) => ({ ...p }))
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let maxD = 0
    let maxI = -1
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b])
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxI >= 0 && maxD > epsilon) {
      keep[maxI] = 1
      stack.push([a, maxI], [maxI, b])
    }
  }
  const out: Point[] = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push({ ...pts[i] })
  return out
}

export function simplifyClosed(pts: Point[], epsilon: number): Point[] {
  if (pts.length < 4) return pts.map((p) => ({ ...p }))
  let split = 0
  let minDot = 2
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(i - 1 + pts.length) % pts.length]
    const c = pts[i]
    const n = pts[(i + 1) % pts.length]
    const v1 = normalize(c.x - p.x, c.y - p.y)
    const v2 = normalize(n.x - c.x, n.y - c.y)
    const dot = v1.x * v2.x + v1.y * v2.y
    if (dot < minDot) {
      minDot = dot
      split = i
    }
  }
  const rotated = [...pts.slice(split), ...pts.slice(0, split), pts[split]]
  const open = simplifyOpen(rotated, epsilon)
  if (open.length > 1) open.pop()
  return open
}

/** 轻度平滑，尖角（折角大约超过 60°）保持不动 */
export function smoothPolyline(pts: Point[], closed: boolean, passes = 2): Point[] {
  let cur = pts.map((p) => ({ ...p }))
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.map((pt, i) => {
      const prev = closed
        ? cur[(i - 1 + cur.length) % cur.length]
        : cur[Math.max(0, i - 1)]
      const nxt = closed ? cur[(i + 1) % cur.length] : cur[Math.min(cur.length - 1, i + 1)]
      if (!closed && (i === 0 || i === cur.length - 1)) return { ...pt }
      const v1 = normalize(pt.x - prev.x, pt.y - prev.y)
      const v2 = normalize(nxt.x - pt.x, nxt.y - pt.y)
      if (v1.x * v2.x + v1.y * v2.y < 0.5) return { ...pt }
      return {
        x: prev.x * 0.22 + pt.x * 0.56 + nxt.x * 0.22,
        y: prev.y * 0.22 + pt.y * 0.56 + nxt.y * 0.22,
      }
    })
    cur = next
  }
  return cur
}
