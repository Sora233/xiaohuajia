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

/** 已经画到画布上的一段轮廓，按点下标占用 */
export type TakenSpan = {
  contourId: number
  /** 含端点，按点序；闭合线跨过起点时拆成多段 */
  spans: Array<[number, number]>
}

export type StrokeMatch = {
  /** 参与变形的这一笔（两端离参考线太远的尾巴会去掉） */
  source: Point[]
  /** 同一条参考轮廓上、从笔迹起点投影到终点投影的那一段 */
  target: Point[]
  contourId: number
  /** 这一段目标占用的轮廓点，之后的笔不再匹配这些点 */
  spans: Array<[number, number]>
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

const JOIN_STEPS = 1

function buildTakenMasks(
  byId: Map<number, Contour>,
  taken: readonly TakenSpan[] | undefined,
): Map<number, Uint8Array> {
  const masks = new Map<number, Uint8Array>()
  if (!taken || taken.length === 0) return masks
  for (const item of taken) {
    const contour = byId.get(item.contourId)
    if (!contour || item.spans.length === 0) continue
    let mask = masks.get(item.contourId)
    if (!mask) {
      mask = new Uint8Array(contour.points.length)
      masks.set(item.contourId, mask)
    }
    const n = mask.length
    for (const [a, b] of item.spans) {
      const lo = Math.max(0, Math.min(a, b))
      const hi = Math.min(n - 1, Math.max(a, b))
      for (let i = lo; i <= hi; i++) mask[i] = 1
    }
  }
  return masks
}

/** 最近点已画过时，只允许跨到紧邻的一格，用来接上还没画的下一段 */
function nearestFreeIndex(
  contour: Contour,
  index: number,
  x: number,
  y: number,
  radius: number,
  mask: Uint8Array,
): number | null {
  const pts = contour.points
  const n = pts.length
  if (n === 0) return null
  const i0 = mod(Math.round(index), n)
  if (!mask[i0]) return i0
  let best = -1
  let bestD = radius
  for (let step = 1; step <= JOIN_STEPS; step++) {
    for (const dir of [-1, 1] as const) {
      const raw = i0 + dir * step
      if (!contour.closed && (raw < 0 || raw >= n)) continue
      const i = mod(raw, n)
      if (mask[i]) continue
      const d = Math.hypot(pts[i].x - x, pts[i].y - y)
      if (d <= radius && (best < 0 || d < bestD)) {
        best = i
        bestD = d
      }
    }
  }
  return best < 0 ? null : best
}

function adoptHit(
  hit: Hit | null,
  contour: Contour,
  tangent: Point,
  x: number,
  y: number,
  radius: number,
  mask?: Uint8Array,
): Hit | null {
  if (!hit || !mask) return hit
  const free = nearestFreeIndex(contour, hit.index, x, y, radius, mask)
  if (free === null) return null
  if (free === mod(Math.round(hit.index), contour.points.length)) return hit
  const tan = tangentAt(contour, free)
  return {
    index: free,
    dist: Math.hypot(contour.points[free].x - x, contour.points[free].y - y),
    dir: tan.x * tangent.x + tan.y * tangent.y,
  }
}

/** 正压在已画线段上，而且附近没有更近的未画线 */
function sampleOnTakenInk(
  hits: Array<{ contourId: number; index: number; dist: number }>,
  byId: Map<number, Contour>,
  masks: Map<number, Uint8Array>,
  x: number,
  y: number,
  radius: number,
): boolean {
  let blocked = Number.POSITIVE_INFINITY
  let free = Number.POSITIVE_INFINITY
  for (const hit of hits) {
    if (hit.dist > radius) continue
    const contour = byId.get(hit.contourId)
    if (!contour) continue
    const mask = masks.get(hit.contourId)
    const taken =
      !!mask && nearestFreeIndex(contour, hit.index, x, y, radius, mask) === null
    if (taken) blocked = Math.min(blocked, hit.dist)
    else free = Math.min(free, hit.dist)
  }
  return blocked + 1 < free
}

function walkContourIndices(contour: Contour, startU: number, endU: number): number[] {
  const n = contour.points.length
  if (n === 0) return []
  const span = endU - startU
  const dir = span >= 0 ? 1 : -1
  const steps = Math.min(n, Math.max(0, Math.round(Math.abs(span))))
  const out: number[] = []
  let i = mod(Math.round(startU), n)
  for (let s = 0; s <= steps; s++) {
    out.push(i)
    if (!contour.closed && (i + dir < 0 || i + dir >= n)) break
    i = mod(i + dir, n)
    if (contour.closed && s > 0 && steps >= n && i === mod(Math.round(startU), n)) break
  }
  return out
}

function compressSpans(indices: number[]): Array<[number, number]> {
  if (indices.length === 0) return []
  const spans: Array<[number, number]> = []
  let lo = indices[0]
  let hi = indices[0]
  for (let k = 1; k < indices.length; k++) {
    const i = indices[k]
    if (i === hi + 1 || i === lo - 1) {
      lo = Math.min(lo, i)
      hi = Math.max(hi, i)
      continue
    }
    spans.push([lo, hi])
    lo = i
    hi = i
  }
  spans.push([lo, hi])
  return spans
}

function markWalk(mask: Uint8Array, contour: Contour, startU: number, endU: number) {
  for (const i of walkContourIndices(contour, startU, endU)) mask[i] = 1
}

type ForwardStep =
  | { kind: 'clear' }
  | { kind: 'blocked'; extendTo: number | null; resume: number | null }

/** 从当前投影走到下一个投影，看中间有没有已经画过的点 */
function classifyStep(contour: Contour, from: number, to: number, mask: Uint8Array): ForwardStep {
  const n = contour.points.length
  const span = to - from
  const dir = span >= 0 ? 1 : -1
  const steps = Math.min(n, Math.max(0, Math.round(Math.abs(span))))
  if (steps === 0) {
    return mask[mod(Math.round(to), n)]
      ? { kind: 'blocked', extendTo: null, resume: null }
      : { kind: 'clear' }
  }
  let i = mod(Math.round(from), n)
  let unwrapped = Math.round(from)
  let seenTaken = false
  let extendTo: number | null = null
  let resume: number | null = null
  for (let s = 1; s <= steps; s++) {
    if (!contour.closed && (i + dir < 0 || i + dir >= n)) break
    i = mod(i + dir, n)
    unwrapped += dir
    if (mask[i]) {
      seenTaken = true
      resume = null
    } else if (!seenTaken) {
      extendTo = unwrapped
    } else if (resume === null) {
      resume = unwrapped
    }
  }
  if (!seenTaken) return { kind: 'clear' }
  return { kind: 'blocked', extendTo, resume }
}

function firstUnwrappedStep(contour: Contour, from: number, to: number): number | null {
  const span = to - from
  if (Math.round(Math.abs(span)) < 1) return null
  const dir = span >= 0 ? 1 : -1
  const raw = Math.round(from) + dir
  if (!contour.closed && (raw < 0 || raw >= contour.points.length)) return null
  return raw
}

/**
 * 抬笔后只选一条最贴合的参考轮廓。
 * 目标是这条轮廓上、从笔迹起点的投影走到终点投影的那一整段（拐角也顺着走）。
 * 已经画过的下标会跳过，同一段线不会再匹配一次；一笔跨过已画段时，只留下还没画的几段。
 * 整笔变形到这些线上；只有两端超出吸附距离的部分会丢掉。
 */
export function matchFinishedStroke(
  raw: Point[],
  contours: Contour[],
  index: SpatialIndex,
  radius: number,
  taken?: readonly TakenSpan[],
): StrokeMatch[] | null {
  if (raw.length < 2 || contours.length === 0 || radius < 1) return null
  const strokeLen = arcLength(raw)
  if (strokeLen < 6) return null

  const sampleCount = Math.max(2, Math.round(strokeLen / SAMPLE_SPACING) + 1)
  const samples = resampleCount(raw, sampleCount)
  if (samples.length < 2) return null
  const byId = new Map(contours.map((c) => [c.id, c]))
  const hits = samples.map((p) => queryHits(p.x, p.y, radius, contours, index))
  const masks = buildTakenMasks(byId, taken)

  const covered = new Map<number, number>()
  let blockedCover = 0
  for (let si = 0; si < samples.length; si++) {
    const sample = samples[si]
    if (
      masks.size > 0 &&
      sampleOnTakenInk(hits[si], byId, masks, sample.x, sample.y, radius)
    ) {
      blockedCover += SAMPLE_SPACING
      continue
    }
    const tangent = sampleTangent(samples, si)
    let bestId = -1
    let bestScore = 0
    for (const hit of hits[si]) {
      if (hit.dist > radius) continue
      const candidate = byId.get(hit.contourId)
      if (!candidate) continue
      const candidateMask = masks.get(hit.contourId)
      let indexForTan = hit.index
      if (candidateMask) {
        const free = nearestFreeIndex(candidate, hit.index, sample.x, sample.y, radius, candidateMask)
        if (free === null) continue
        indexForTan = free
      }
      const tan = tangentAt(candidate, indexForTan)
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
  const mask = masks.get(contour.id)
  // 贴住的部分太少，就当作没描到线，整笔淡出。压在已画线上的长度不算进分母。
  const activeLen = Math.max(0, strokeLen - blockedCover)
  if (bestCover < Math.max(16, activeLen * 0.22)) return null

  let sign = 0
  let travel = 0
  let travelN = 0
  let prevIdx = -1
  let tangentVote = 0
  let tangentN = 0
  for (let si = 0; si < samples.length && travelN < 10; si++) {
    const tangent = sampleTangent(samples, si)
    const hit = adoptHit(
      hitOn(hits[si], contour, tangent, radius),
      contour,
      tangent,
      samples[si].x,
      samples[si].y,
      radius,
      mask,
    )
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

  type Run = { startU: number; endU: number; firstSi: number; lastSi: number }
  const runs: Run[] = []
  let run: Run | null = null
  let cursor = 0
  let prevSi = -1
  let skipping = false

  const commit = () => {
    if (run && run.lastSi > run.firstSi) {
      runs.push(run)
      if (mask) markWalk(mask, contour, run.startU, run.endU)
    }
    run = null
  }

  for (let si = 0; si < samples.length; si++) {
    if (!run && !skipping) {
      const tangent = sampleTangent(samples, si)
      const hit = adoptHit(
        hitOn(hits[si], contour, tangent, radius),
        contour,
        tangent,
        samples[si].x,
        samples[si].y,
        radius,
        mask,
      )
      if (!hit) continue
      run = { startU: hit.index, endU: hit.index, firstSi: si, lastSi: si }
      cursor = hit.index
      prevSi = si
      continue
    }

    const moved = Math.hypot(samples[si].x - samples[prevSi].x, samples[si].y - samples[prevSi].y)
    const from = cursor
    const next = projectForward(contour, samples[si].x, samples[si].y, from, sign, radius, moved * 3 + 36)
    if (next === null) continue

    if (mask) {
      const step = classifyStep(contour, from, next, mask)
      if (step.kind === 'blocked') {
        if (run && step.extendTo !== null) run.endU = step.extendTo
        commit()
        cursor = next
        prevSi = si
        if (step.resume === null) {
          skipping = true
        } else {
          skipping = false
          run = { startU: step.resume, endU: next, firstSi: si, lastSi: si }
        }
        continue
      }
    }

    cursor = next
    prevSi = si
    if (!run) {
      const startU = firstUnwrappedStep(contour, from, next) ?? next
      run = { startU, endU: next, firstSi: si, lastSi: si }
      skipping = false
      continue
    }
    run.endU = next
    run.lastSi = si
    skipping = false
  }
  commit()
  if (runs.length === 0) return null

  const denom = Math.max(1, samples.length - 1)
  const pieces: StrokeMatch[] = []
  for (const piece of runs) {
    let f0 = piece.firstSi / denom
    let f1 = piece.lastSi / denom
    if (f0 < 0.06) f0 = 0
    if (f1 > 0.94) f1 = 1
    const source =
      f0 <= 0 && f1 >= 1 ? raw.map((p) => ({ ...p })) : slicePolylineByFraction(raw, f0, f1)
    let target = sliceContour(contour, piece.startU, piece.endU)
    if (source.length < 2 || target.length < 2) continue
    target = orientPolyline(source, target)
    const sl = arcLength(source)
    const tl = arcLength(target)
    if (tl < 10 || sl < 6) continue
    // 闭合线不要绕远路，把整圈都算进这一笔
    if (contour.closed && tl > sl * 1.8 + 36 && tl > arcLength(contour.points) * 0.72) continue
    const spans = compressSpans(walkContourIndices(contour, piece.startU, piece.endU))
    if (spans.length === 0) continue
    pieces.push({ source, target, contourId: contour.id, spans })
  }
  return pieces.length > 0 ? pieces : null
}
