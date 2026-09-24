import {
  queryHits,
  sliceContour,
  type Contour,
  type SpatialIndex,
} from '@/lib/contours'
import {
  arcLength,
  orientPolyline,
  resampleCount,
  slicePolylineByFraction,
  type Point,
} from '@/lib/polyline'

export type StrokeMatch = {
  /** 参与变形的这一笔（两端离参考线太远的尾巴会去掉） */
  source: Point[]
  /** 同一条参考轮廓上、从笔迹起点投影到终点投影的那一段 */
  target: Point[]
}

const SAMPLE_SPACING = 4

function mod(i: number, n: number) {
  return ((i % n) + n) % n
}

function sampleTangent(samples: Point[], i: number): Point {
  const a = samples[Math.max(0, i - 1)]
  const b = samples[Math.min(samples.length - 1, i + 1)]
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

function tangentAt(contour: Contour, index: number): Point {
  const pts = contour.points
  const n = pts.length
  if (n < 2) return { x: 1, y: 0 }
  const i = mod(Math.round(index), n)
  const i0 = contour.closed ? mod(i - 2, n) : Math.max(0, i - 2)
  const i1 = contour.closed ? mod(i + 2, n) : Math.min(n - 1, i + 2)
  const l = Math.hypot(pts[i1].x - pts[i0].x, pts[i1].y - pts[i0].y) || 1
  return { x: (pts[i1].x - pts[i0].x) / l, y: (pts[i1].y - pts[i0].y) / l }
}

type Hit = { index: number; dist: number; dir: number }

function hitOn(
  hits: Array<{ contourId: number; index: number; dist: number }>,
  contour: Contour,
  tangent: Point,
  radius: number,
): Hit | null {
  let best: Hit | null = null
  let bestD = radius + 1
  for (const hit of hits) {
    if (hit.contourId !== contour.id || hit.dist > radius) continue
    if (hit.dist < bestD) {
      bestD = hit.dist
      const tan = tangentAt(contour, hit.index)
      best = {
        index: hit.index,
        dist: hit.dist,
        dir: tan.x * tangent.x + tan.y * tangent.y,
      }
    }
  }
  return best
}

/**
 * 从当前下标顺着笔迹方向找下一个投影。
 * 只往前看一段，避免折返的轮廓把笔吸回已经走过的地方。
 */
function projectForward(
  contour: Contour,
  x: number,
  y: number,
  from: number,
  sign: number,
  radius: number,
  maxArc: number,
): number | null {
  const pts = contour.points
  const n = pts.length
  if (n < 2) return null
  let best = -1
  let bestD = radius
  let arc = 0
  let i = Math.round(from)
  const limit = n + 2
  for (let step = 0; step < limit; step++) {
    const p = pts[mod(i, n)]
    const d = Math.hypot(p.x - x, p.y - y)
    if (d < bestD) {
      bestD = d
      best = i
    }
    if (!contour.closed && ((sign >= 0 && i >= n - 1) || (sign < 0 && i <= 0))) break
    const next = i + sign
    if (contour.closed && step > 0 && mod(next, n) === mod(Math.round(from), n)) break
    const a = pts[mod(i, n)]
    const b = pts[mod(next, n)]
    arc += Math.hypot(b.x - a.x, b.y - a.y)
    if (step > 2 && arc > maxArc) break
    i = next
  }
  return best < 0 ? null : best
}

/**
 * 抬笔后只选一条最贴合的参考轮廓。
 * 目标是这条轮廓上、从笔迹起点的投影走到终点投影的那一整段（拐角也顺着走）。
 * 整笔变形到这一条线上；只有两端超出吸附距离的部分会丢掉。
 */
export function matchFinishedStroke(
  raw: Point[],
  contours: Contour[],
  index: SpatialIndex,
  radius: number,
): StrokeMatch[] | null {
  if (raw.length < 2 || contours.length === 0 || radius < 1) return null
  const strokeLen = arcLength(raw)
  if (strokeLen < 6) return null

  const sampleCount = Math.max(2, Math.round(strokeLen / SAMPLE_SPACING) + 1)
  const samples = resampleCount(raw, sampleCount)
  if (samples.length < 2) return null
  const byId = new Map(contours.map((c) => [c.id, c]))
  const hits = samples.map((p) => queryHits(p.x, p.y, radius, contours, index))

  const covered = new Map<number, number>()
  for (let si = 0; si < samples.length; si++) {
    const tangent = sampleTangent(samples, si)
    let bestId = -1
    let bestScore = 0
    for (const hit of hits[si]) {
      if (hit.dist > radius) continue
      const contour = byId.get(hit.contourId)
      if (!contour) continue
      const tan = tangentAt(contour, hit.index)
      const align = Math.abs(tan.x * tangent.x + tan.y * tangent.y)
      if (align < 0.12 && hit.dist > radius * 0.55) continue
      const score = (0.2 + align) * (1.08 - hit.dist / Math.max(1, radius))
      if (score > bestScore) {
        bestScore = score
        bestId = hit.contourId
      }
    }
    if (bestId >= 0) covered.set(bestId, (covered.get(bestId) ?? 0) + SAMPLE_SPACING)
  }

  let cid = -1
  let bestCover = 0
  for (const [id, len] of covered) {
    if (len > bestCover) {
      bestCover = len
      cid = id
    }
  }
  const contour = cid >= 0 ? byId.get(cid) : undefined
  if (!contour) return null
  const n = contour.points.length
  // 贴住的部分太少，就当作没描到线，整笔淡出
  if (bestCover < Math.max(16, strokeLen * 0.22)) return null

  let sign = 0
  let travel = 0
  let travelN = 0
  let prevIdx = -1
  let tangentVote = 0
  let tangentN = 0
  for (let si = 0; si < samples.length && travelN < 10; si++) {
    const hit = hitOn(hits[si], contour, sampleTangent(samples, si), radius)
    if (!hit) continue
    if (Math.abs(hit.dir) >= 0.08) {
      tangentVote += hit.dir
      tangentN++
    }
    if (prevIdx >= 0) {
      let du = hit.index - prevIdx
      if (contour.closed) {
        if (du > n / 2) du -= n
        if (du < -n / 2) du += n
      }
      travel += du
      travelN++
    }
    prevIdx = hit.index
  }
  if (tangentN === 0 && travelN === 0) return null
  if (Math.abs(travel) >= 2) sign = travel < 0 ? -1 : 1
  else sign = tangentVote < 0 ? -1 : 1

  let startU = 0
  let cursor = 0
  let firstSi = -1
  let lastSi = -1
  let prevSi = -1
  for (let si = 0; si < samples.length; si++) {
    if (firstSi < 0) {
      const hit = hitOn(hits[si], contour, sampleTangent(samples, si), radius)
      if (!hit) continue
      startU = hit.index
      cursor = hit.index
      firstSi = si
      lastSi = si
      prevSi = si
      continue
    }
    const moved = Math.hypot(samples[si].x - samples[prevSi].x, samples[si].y - samples[prevSi].y)
    const next = projectForward(contour, samples[si].x, samples[si].y, cursor, sign, radius, moved * 3 + 36)
    if (next === null) continue
    cursor = next
    lastSi = si
    prevSi = si
  }
  if (firstSi < 0 || lastSi <= firstSi) return null

  const denom = Math.max(1, samples.length - 1)
  let f0 = firstSi / denom
  let f1 = lastSi / denom
  if (f0 < 0.06) f0 = 0
  if (f1 > 0.94) f1 = 1
  const source =
    f0 <= 0 && f1 >= 1 ? raw.map((p) => ({ ...p })) : slicePolylineByFraction(raw, f0, f1)
  let target = sliceContour(contour, startU, cursor)
  if (source.length < 2 || target.length < 2) return null
  target = orientPolyline(source, target)
  const sl = arcLength(source)
  const tl = arcLength(target)
  if (tl < 10 || sl < 6) return null
  // 闭合线不要绕远路，把整圈都算进这一笔
  if (contour.closed && tl > sl * 1.8 + 36 && tl > arcLength(contour.points) * 0.72) return null
  return [{ source, target }]
}
