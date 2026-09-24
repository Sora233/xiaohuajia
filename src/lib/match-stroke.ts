import {
  contourTangent,
  distanceToOpenEnd,
  queryHits,
  sliceContour,
  type Contour,
  type NearestHit,
  type SpatialIndex,
} from '@/lib/contours'
import {
  arcLength,
  dist,
  orientPolyline,
  resampleCount,
  slicePolylineByFraction,
  type Point,
} from '@/lib/polyline'

export type StrokeMatch = {
  /** 参与变形的用户笔迹（整笔或其中一段） */
  source: Point[]
  /** 按笔迹方向排好的目标参考线 */
  target: Point[]
}

type SampleHit = NearestHit & { dir: number }

type Run = {
  cid: number
  from: number
  to: number
  startU: number
  endU: number
  score: number
  sampleSpan: number
  avgAbsDir: number
  avgDist: number
}

const SAMPLE_SPACING = 4

function unwrapDelta(d: number, n: number, closed: boolean) {
  if (!closed || n <= 0) return d
  let x = d
  if (x > n / 2) x -= n
  if (x < -n / 2) x += n
  return x
}

function sampleTangents(samples: Point[]): Point[] {
  return samples.map((_, i) => {
    const a = samples[Math.max(0, i - 1)]
    const b = samples[Math.min(samples.length - 1, i + 1)]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
  })
}

/** 在已知下标附近找更连贯的投影，避免折返轮廓被全局最近点抢走 */
function projectWindow(
  contour: Contour,
  x: number,
  y: number,
  hint: number,
  radius: number,
): { index: number; dist: number } | null {
  const pts = contour.points
  const n = pts.length
  if (n === 0) return null
  const win = 18
  let bestI = -1
  let bestD = radius + 1
  if (contour.closed) {
    const h = ((Math.round(hint) % n) + n) % n
    for (let k = -win; k <= win; k++) {
      const i = (h + k + n * 2) % n
      const d = Math.hypot(pts[i].x - x, pts[i].y - y)
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
  } else {
    const lo = Math.max(0, Math.round(hint) - win)
    const hi = Math.min(n - 1, Math.round(hint) + win)
    for (let i = lo; i <= hi; i++) {
      const d = Math.hypot(pts[i].x - x, pts[i].y - y)
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
  }
  if (bestI < 0 || bestD > radius) return null
  return { index: bestI, dist: bestD }
}

function evaluateContour(
  contour: Contour,
  samples: Point[],
  tangents: Point[],
  hits: SampleHit[][],
  radius: number,
): Run | null {
  const n = contour.points.length
  if (n < 2) return null

  type Obs = { si: number; idx: number; dist: number; dir: number }
  const seq: Obs[] = []
  let hint = -1
  for (let si = 0; si < samples.length; si++) {
    const global = hits[si].find((h) => h.contourId === contour.id)
    let idx = global?.index ?? -1
    let d = global?.dist ?? Infinity
    if (hint >= 0) {
      const local = projectWindow(contour, samples[si].x, samples[si].y, hint, radius)
      if (local && (idx < 0 || local.dist <= d + 8)) {
        idx = local.index
        d = local.dist
      }
    }
    if (idx < 0 || d > radius) continue
    const tan = contourTangent(contour, idx)
    const dir = tan.x * tangents[si].x + tan.y * tangents[si].y
    if (Math.abs(dir) < 0.12 && d > radius * 0.42) continue
    seq.push({ si, idx, dist: d, dir })
    hint = idx
  }
  if (seq.length < 2) return null

  const deltas: number[] = []
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].si - seq[i - 1].si > 5) continue
    deltas.push(unwrapDelta(seq[i].idx - seq[i - 1].idx, n, contour.closed))
  }
  let sign = 0
  if (deltas.length) {
    const sorted = deltas.slice().sort((a, b) => a - b)
    sign = Math.sign(sorted[sorted.length >> 1])
  }
  if (sign === 0) {
    sign =
      Math.sign(unwrapDelta(seq[seq.length - 1].idx - seq[0].idx, n, contour.closed)) ||
      1
  }

  let best: Run | null = null
  let runS = 0
  let u = seq[0].idx
  let u0 = u
  let lastGoodK = 0
  let lastGoodU = u
  let stall = 0

  const consider = (end: number, endU: number) => {
    if (end < runS) return
    const sampleSpan = seq[end].si - seq[runS].si + 1
    if (sampleSpan < 2) return
    let dirSum = 0
    let distSum = 0
    const count = end - runS + 1
    for (let k = runS; k <= end; k++) {
      dirSum += Math.abs(seq[k].dir)
      distSum += seq[k].dist
    }
    const avgAbsDir = dirSum / count
    const avgDist = distSum / count
    const indexSpan = Math.abs(endU - u0)
    if (indexSpan < 2 && sampleSpan < 4) return
    if (avgAbsDir < 0.18 && sampleSpan < 6) return
    const prox = 1 - avgDist / Math.max(1, radius)
    const score =
      sampleSpan * (0.45 + avgAbsDir) * (0.4 + prox) + Math.min(indexSpan, sampleSpan * 4) * 0.08
    if (!best || score > best.score) {
      best = {
        cid: contour.id,
        from: seq[runS].si,
        to: seq[end].si,
        startU: u0,
        endU,
        score,
        sampleSpan,
        avgAbsDir,
        avgDist,
      }
    }
  }

  const restart = (k: number) => {
    runS = k
    u = seq[k].idx
    u0 = u
    lastGoodK = k
    lastGoodU = u
    stall = 0
  }

  for (let k = 1; k < seq.length; k++) {
    const prevIdx = ((Math.round(u) % n) + n) % n
    const du = unwrapDelta(seq[k].idx - prevIdx, n, contour.closed)
    const forward = du * sign
    const gap = seq[k].si - seq[k - 1].si
    const maxForward = 8 + gap * 6
    if (forward >= 1) stall = 0
    else stall += Math.max(1, gap) * SAMPLE_SPACING
    // 下标停住但笔还在往前走：说明已经离开这条轮廓，停在端点附近
    const parked = forward <= 0 && stall > 24
    const bad = forward < -4 || forward > maxForward || gap > 8 || parked
    if (bad) {
      consider(lastGoodK, lastGoodU)
      restart(k)
      continue
    }
    u += du
    if (forward >= 1) {
      lastGoodK = k
      lastGoodU = u
    }
    consider(lastGoodK, lastGoodU)
  }
  return best
}

function rangesOverlap(a: Run, b: Run) {
  const lo = Math.max(a.from, b.from)
  const hi = Math.min(a.to, b.to)
  const overlap = hi - lo + 1
  if (overlap <= 0) return false
  const aSpan = a.to - a.from + 1
  const bSpan = b.to - b.from + 1
  // 只在转角处重叠、两边各自还有一段：这是一笔跨两条线，不是重复匹配
  if (aSpan - overlap >= 3 && bSpan - overlap >= 3) return false
  return overlap > 2
}

function canConnect(
  prev: Run,
  next: Run,
  byId: Map<number, Contour>,
  radius: number,
) {
  if (next.from - prev.to > 6) return false
  if (prev.to - next.from > 6) return false
  const a = byId.get(prev.cid)
  const b = byId.get(next.cid)
  if (!a || !b) return false
  const aPts = sliceContour(a, prev.startU, prev.endU)
  const bPts = sliceContour(b, next.startU, next.endU)
  if (aPts.length < 2 || bPts.length < 2) return false
  const aEnd = aPts[aPts.length - 1]
  const gap = Math.min(dist(aEnd, bPts[0]), dist(aEnd, bPts[bPts.length - 1]))
  const joinDist = Math.max(18, Math.min(28, radius * 0.7))
  if (gap > joinDist) return false

  const aEndIdx = prev.endU >= prev.startU ? prev.endU : prev.startU
  const bMeetIdx = dist(aEnd, bPts[0]) <= dist(aEnd, bPts[bPts.length - 1]) ? next.startU : next.endU
  const aAtEnd = a.closed ? gap <= 10 : distanceToOpenEnd(a, aEndIdx) <= 20
  const bAtEnd = b.closed ? gap <= 10 : distanceToOpenEnd(b, bMeetIdx) <= 20
  // 直角拐角、分叉处：至少有一端贴着轮廓端点；平行线的中段不会被接上
  return aAtEnd || bAtEnd || gap <= 8
}

function buildTarget(parts: Run[], byId: Map<number, Contour>): Point[] {
  const out: Point[] = []
  for (const part of parts) {
    const contour = byId.get(part.cid)
    if (!contour) continue
    let pts = sliceContour(contour, part.startU, part.endU)
    if (pts.length < 2) continue
    if (out.length === 0) {
      out.push(...pts)
      continue
    }
    const end = out[out.length - 1]
    if (dist(end, pts[pts.length - 1]) < dist(end, pts[0])) pts = [...pts].reverse()
    const skip = dist(end, pts[0]) < 1.4 ? 1 : 0
    for (let i = skip; i < pts.length; i++) out.push(pts[i])
  }
  return out
}

function plausible(source: Point[], target: Point[]) {
  const sl = arcLength(source)
  const tl = arcLength(target)
  if (tl < 8 || source.length < 2 || target.length < 2) return false
  if (sl > 56 && tl < sl * 0.12) return false
  if (tl > sl * 2.6 + 36) return false
  return true
}

/**
 * 整笔抬起来之后再匹配：按覆盖长度和走向挑轮廓段，
 * 相连的几段会接成一条（或几条）目标线。
 * 没有任何一段落在吸附距离内时返回 null。
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

  const samples = resampleCount(raw, Math.max(2, Math.round(strokeLen / SAMPLE_SPACING) + 1))
  if (samples.length < 2) return null
  const tangents = sampleTangents(samples)
  const byId = new Map(contours.map((c) => [c.id, c]))

  const hits: SampleHit[][] = samples.map((p, si) => {
    const found = queryHits(p.x, p.y, radius, contours, index)
    const st = tangents[si]
    return found.map((h) => {
      const c = byId.get(h.contourId)
      const tan = c ? contourTangent(c, h.index) : { x: 1, y: 0 }
      return { ...h, dir: tan.x * st.x + tan.y * st.y }
    })
  })

  const nearCount = hits.filter((h) => h.length > 0).length
  if (nearCount < Math.min(3, samples.length) || nearCount / samples.length < 0.2) return null

  const runs: Run[] = []
  for (const contour of contours) {
    const run = evaluateContour(contour, samples, tangents, hits, radius)
    if (run) runs.push(run)
  }
  if (runs.length === 0) return null
  runs.sort((a, b) => b.score - a.score)

  const chosen: Run[] = []
  const bestScore = runs[0].score
  for (const run of runs) {
    if (run.score < bestScore * 0.2 && run.sampleSpan < samples.length * 0.18) continue
    if (chosen.some((c) => rangesOverlap(c, run))) continue
    chosen.push(run)
  }
  if (chosen.length === 0) return null
  chosen.sort((a, b) => a.from - b.from)

  const chains: Run[][] = []
  for (const run of chosen) {
    const prev = chains[chains.length - 1]
    if (prev && canConnect(prev[prev.length - 1], run, byId, radius)) prev.push(run)
    else chains.push([run])
  }

  const matches: StrokeMatch[] = []
  const spans = chains
    .map((chain) => ({
      from: chain[0].from,
      to: chain[chain.length - 1].to,
      target: buildTarget(chain, byId),
    }))
    .filter((s) => s.target.length >= 2)

  if (spans.length === 0) return null

  if (spans.length === 1) {
    const span = spans[0]
    const f0 = span.from / Math.max(1, samples.length - 1)
    const f1 = span.to / Math.max(1, samples.length - 1)
    let source = raw.slice()
    if (!plausible(source, span.target)) source = slicePolylineByFraction(raw, f0, f1)
    if (!plausible(source, span.target)) return null
    return [{ source, target: orientPolyline(source, span.target) }]
  }

  const cuts = [0]
  for (let i = 0; i < spans.length - 1; i++) {
    const mid = (spans[i].to + spans[i + 1].from) / 2
    cuts.push(mid / Math.max(1, samples.length - 1))
  }
  cuts.push(1)

  for (let i = 0; i < spans.length; i++) {
    let source = slicePolylineByFraction(raw, cuts[i], cuts[i + 1])
    const f0 = spans[i].from / Math.max(1, samples.length - 1)
    const f1 = spans[i].to / Math.max(1, samples.length - 1)
    if (!plausible(source, spans[i].target)) source = slicePolylineByFraction(raw, f0, f1)
    if (!plausible(source, spans[i].target)) continue
    matches.push({ source, target: orientPolyline(source, spans[i].target) })
  }
  return matches.length ? matches : null
}
