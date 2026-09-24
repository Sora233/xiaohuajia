import { queryHits, sliceContour, type Contour, type SpatialIndex } from '@/lib/contours'
import {
  arcLength,
  dedupePoints,
  normalize,
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
  /** 整笔都参与变形，长短不够就拉伸或缩短。跨过已画段时只留下还没画的几段 */
  source: Point[]
  /** 同一条参考轮廓上、从笔迹起点投影到终点投影的那一段 */
  target: Point[]
  contourId: number
  /** 这一段目标占用的轮廓点，之后的笔不再匹配这些点 */
  spans: Array<[number, number]>
}

const SAMPLE_N = 36

/**
 * 滑块仍是容差。搜索比滑块更宽：默认 36 时大约 50px 的偏移还能吸上，
 * 半径 20、偏出约 50px 仍会落空。阈值不随笔迹变长而变严。
 */
function searchRadiusOf(radius: number) {
  return Math.min(140, Math.max(radius + 12, radius * 2.15))
}

function mod(i: number, n: number) {
  return ((i % n) + n) % n
}

/** 目标几乎不动、笔却走了很长：只是擦过，不是顺着这条线 */
function grazes(advance: number, near: Point[]) {
  if (near.length < 2) return true
  const span = arcLength(near)
  return advance < 70 && advance + 20 < span * 0.34
}

function meanAlign(samples: Point[], target: Point[]) {
  if (target.length < 2 || samples.length < 2) return 0
  const n = Math.min(8, Math.max(3, samples.length))
  const a = resampleCount(samples, n)
  const b = resampleCount(target, n)
  let sum = 0
  let count = 0
  for (let i = 1; i < n - 1; i++) {
    const st = normalize(a[i + 1].x - a[i - 1].x, a[i + 1].y - a[i - 1].y)
    const tt = normalize(b[i + 1].x - b[i - 1].x, b[i + 1].y - b[i - 1].y)
    sum += Math.abs(st.x * tt.x + st.y * tt.y)
    count++
  }
  return count ? sum / count : 0
}

type Obs = { si: number; index: number; dist: number }

type Built = {
  target: Point[]
  mean: number
  covered: number
  align: number
  advance: number
  score: number
  startU: number
  endU: number
}

/**
 * 在笔迹顺序上找一段下标大体单调的投影。
 * 轮廓折返回来、局部更近的另一截会被当成离群点跳过，不会把目标切成一小段。
 */
function monotoneChain(obs: Obs[], sign: number, n: number, closed: boolean): number[] {
  const m = obs.length
  if (m === 0) return []
  const prev = new Int32Array(m).fill(-1)
  const len = new Int32Array(m).fill(1)
  const jump = new Float64Array(m).fill(0)
  let best = 0
  const stepCap = Math.max(90, n * 0.3)
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < i; j++) {
      let du = obs[i].index - obs[j].index
      if (closed) {
        if (du > n / 2) du -= n
        if (du < -n / 2) du += n
      }
      const forward = sign > 0 ? du : -du
      if (forward < -10 || forward > stepCap) continue
      const better = len[j] + 1 > len[i] || (len[j] + 1 === len[i] && forward < jump[i])
      if (!better) continue
      len[i] = len[j] + 1
      prev[i] = j
      jump[i] = forward
    }
    if (len[i] > len[best] || (len[i] === len[best] && obs[i].dist < obs[best].dist)) best = i
  }
  const chain: number[] = []
  for (let i = best; i >= 0; i = prev[i]) {
    chain.push(i)
    if (prev[i] < 0) break
  }
  chain.reverse()
  return chain
}

function buildChain(
  contour: Contour,
  samples: Point[],
  obs: Obs[],
  searchR: number,
  sign: number,
): Built | null {
  const n = contour.points.length
  const chain = monotoneChain(obs, sign, n, contour.closed)
  if (chain.length < 4) return null
  const picked = chain.map((i) => obs[i])
  const mean = picked.reduce((s, o) => s + o.dist, 0) / picked.length
  if (mean > searchR * 0.96) return null

  let startU = picked[0].index
  let endU = picked[picked.length - 1].index
  if (!contour.closed) {
    if (sign > 0) {
      if (startU <= 12) startU = 0
      if (endU >= n - 13) endU = n - 1
    } else {
      if (startU >= n - 13) startU = n - 1
      if (endU <= 12) endU = 0
    }
  }

  let target: Point[]
  if (contour.closed && Math.abs(endU - startU) >= n * 0.92) {
    const origin = mod(Math.round(startU), n)
    startU = origin
    endU = origin + (sign >= 0 ? n : -n)
    target = sliceContour(contour, startU, endU)
  } else {
    target = sliceContour(contour, startU, endU)
  }
  if (target.length < 2) return null
  const near = picked.map((o) => samples[o.si])
  target = orientPolyline(near, target)
  let advance = arcLength(target)
  if (advance < 18) {
    const whole = arcLength(contour.points)
    if (whole <= 220 && whole > advance + 8 && mean <= searchR * 0.72) {
      target = orientPolyline(near, contour.points.map((p) => ({ ...p })))
      advance = whole
      startU = 0
      endU = contour.closed ? n : n - 1
    }
  }
  if (advance < 8) return null
  const align = meanAlign(near, target)
  if (align < 0.16 && advance < 40) return null
  if (grazes(advance, near)) return null
  const score = (searchR - mean) * picked.length + align * 10 + Math.min(advance, 1200) * 0.035
  return { target, mean, covered: picked.length, align, advance, score, startU, endU }
}

function projectAhead(
  contour: Contour,
  x: number,
  y: number,
  from: number,
  sign: number,
  radius: number,
  maxArc: number,
  penMoved: number,
): number | null {
  const pts = contour.points
  const n = pts.length
  if (n < 2) return null
  let best = -1
  let bestCost = Infinity
  let arc = 0
  let i = Math.round(from)
  for (let step = 0; step < n + 2; step++) {
    const p = pts[mod(i, n)]
    const d = Math.hypot(p.x - x, p.y - y)
    if (d <= radius) {
      const cost = d + 0.65 * Math.abs(arc - penMoved)
      if (cost < bestCost) {
        bestCost = cost
        best = i
      }
    }
    if (!contour.closed && ((sign >= 0 && i >= n - 1) || (sign < 0 && i <= 0))) break
    const next = i + sign
    if (contour.closed && step > 0 && mod(next, n) === mod(Math.round(from), n)) break
    const a = pts[mod(i, n)]
    const b = pts[mod(next, n)]
    arc += Math.hypot(b.x - a.x, b.y - a.y)
    if (step > 1 && arc > maxArc) break
    i = next
  }
  return best < 0 ? null : best
}

/** 从贴得最近的一点顺着笔走，只在附近的弧长里找，避免跳到折返的另一侧 */
function followSign(
  contour: Contour,
  samples: Point[],
  searchR: number,
  anchorSi: number,
  anchorIndex: number,
  sign: number,
): Built | null {
  const n = contour.points.length
  const at = new Array<number>(samples.length).fill(Number.NaN)
  const seen = new Array<boolean>(samples.length).fill(false)
  at[anchorSi] = anchorIndex
  seen[anchorSi] = true
  const stepTo = (si: number, prevSi: number, cursor: number, dir: number) => {
    const moved = Math.hypot(samples[si].x - samples[prevSi].x, samples[si].y - samples[prevSi].y)
    const next = projectAhead(
      contour,
      samples[si].x,
      samples[si].y,
      cursor,
      dir,
      searchR,
      Math.max(110, moved * 3.2 + searchR),
      moved,
    )
    if (next === null) return cursor
    seen[si] = true
    return next
  }
  let cursor = anchorIndex
  for (let si = anchorSi + 1; si < samples.length; si++) {
    cursor = stepTo(si, si - 1, cursor, sign)
    at[si] = cursor
  }
  cursor = anchorIndex
  for (let si = anchorSi - 1; si >= 0; si--) {
    cursor = stepTo(si, si + 1, cursor, -sign)
    at[si] = cursor
  }
  const near: Point[] = []
  let distSum = 0
  let first = -1
  let last = -1
  for (let si = 0; si < samples.length; si++) {
    if (!seen[si] || Number.isNaN(at[si])) continue
    const d = Math.hypot(
      samples[si].x - contour.points[mod(Math.round(at[si]), n)].x,
      samples[si].y - contour.points[mod(Math.round(at[si]), n)].y,
    )
    if (d > searchR) continue
    if (first < 0) first = si
    last = si
    distSum += d
    near.push(samples[si])
  }
  if (near.length < 4 || first < 0 || last <= first) return null
  const mean = distSum / near.length
  let startU = at[first]
  let endU = at[last]
  if (!contour.closed) {
    const lo = Math.min(startU, endU)
    const hi = Math.max(startU, endU)
    const nlo = lo <= 8 ? 0 : lo
    const nhi = hi >= n - 9 ? n - 1 : hi
    if (startU <= endU) {
      startU = nlo
      endU = nhi
    } else {
      startU = nhi
      endU = nlo
    }
  }
  let target = sliceContour(contour, startU, endU)
  if (target.length < 2) return null
  target = orientPolyline(near, target)
  const advance = arcLength(target)
  if (advance < 8) return null
  const align = meanAlign(near, target)
  if (mean > searchR * 0.96) return null
  if (align < 0.16 && advance < 40) return null
  if (grazes(advance, near)) return null
  const score = (searchR - mean) * near.length + align * 10 + Math.min(advance, 1200) * 0.035
  return { target, mean, covered: near.length, align, advance, score, startU, endU }
}

function betterBuilt(a: Built | null, b: Built | null) {
  if (!a) return b
  if (!b) return a
  return b.score > a.score ? b : a
}

function indexTaken(mask: Uint8Array | undefined, index: number, n: number) {
  if (!mask || n === 0) return false
  return mask[mod(Math.round(index), n)] === 1
}

function matchContour(
  contour: Contour,
  samples: Point[],
  hits: Array<Array<{ contourId: number; index: number; dist: number }>>,
  searchR: number,
  mask?: Uint8Array,
): Built | null {
  const obs: Obs[] = []
  const n = contour.points.length
  for (let si = 0; si < samples.length; si++) {
    const hit = hits[si].find((h) => h.contourId === contour.id)
    if (!hit || hit.dist > searchR) continue
    if (indexTaken(mask, hit.index, n)) continue
    obs.push({ si, index: hit.index, dist: hit.dist })
  }
  if (obs.length < 4) return null
  let best = betterBuilt(
    buildChain(contour, samples, obs, searchR, 1),
    buildChain(contour, samples, obs, searchR, -1),
  )
  let anchor = obs[0]
  for (const o of obs) if (o.dist < anchor.dist) anchor = o
  best = betterBuilt(best, followSign(contour, samples, searchR, anchor.si, anchor.index, 1))
  best = betterBuilt(best, followSign(contour, samples, searchR, anchor.si, anchor.index, -1))
  return best
}

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

/** 正压在已画线段上，而且附近没有更近的未画线 */
function sampleOnTakenInk(
  hits: Array<{ contourId: number; index: number; dist: number }>,
  byId: Map<number, Contour>,
  masks: Map<number, Uint8Array>,
): boolean {
  let blocked = Number.POSITIVE_INFINITY
  let free = Number.POSITIVE_INFINITY
  for (const hit of hits) {
    const contour = byId.get(hit.contourId)
    if (!contour) continue
    if (indexTaken(masks.get(hit.contourId), hit.index, contour.points.length)) {
      blocked = Math.min(blocked, hit.dist)
    } else {
      free = Math.min(free, hit.dist)
    }
  }
  return blocked + 1 < free
}

function emitMatches(
  contour: Contour,
  raw: Point[],
  built: Built,
  mask: Uint8Array | undefined,
): StrokeMatch[] | null {
  const indices = walkContourIndices(contour, built.startU, built.endU)
  if (indices.length < 2) return null
  const hasTaken = !!mask && indices.some((i) => mask[i] === 1)
  if (!hasTaken) {
    const source = raw.map((p) => ({ ...p }))
    const target = orientPolyline(source, built.target)
    if (target.length < 2 || arcLength(target) < 8) return null
    const spans = compressSpans(indices)
    if (spans.length === 0) return null
    return [{ source, target, contourId: contour.id, spans }]
  }

  const pieces: StrokeMatch[] = []
  const denom = Math.max(1, indices.length - 1)
  let run: number[] = []
  let runStart = 0
  const flush = (end: number) => {
    if (run.length < 2) {
      run = []
      return
    }
    const f0 = runStart / denom
    const f1 = end / denom
    const source = slicePolylineByFraction(raw, f0, f1)
    let target = dedupePoints(run.map((i) => ({ ...contour.points[i] })))
    if (source.length < 2 || target.length < 2) {
      run = []
      return
    }
    target = orientPolyline(source, target)
    if (arcLength(target) < 8) {
      run = []
      return
    }
    const spans = compressSpans(run)
    if (spans.length > 0) pieces.push({ source, target, contourId: contour.id, spans })
    run = []
  }
  for (let k = 0; k < indices.length; k++) {
    if (mask![indices[k]]) {
      if (run.length > 0) flush(k - 1)
      continue
    }
    if (run.length === 0) runStart = k
    run.push(indices[k])
  }
  if (run.length > 0) flush(indices.length - 1)
  return pieces.length > 0 ? pieces : null
}

/**
 * 抬笔后只选一条参考轮廓。
 * 看整段形状和位置，不拿笔迹长度去卡目标长度。
 * 目标是这条轮廓上从起点投影走到终点投影的一段；笔伸出端点就收到轮廓为止。
 * 已经画过的下标会跳过，同一段线不会再匹配一次。
 * 整笔再按弧长拉到这段上。周围没有够近的线才放弃。
 */
export function matchFinishedStroke(
  raw: Point[],
  contours: Contour[],
  index: SpatialIndex,
  radius: number,
  taken?: readonly TakenSpan[],
): StrokeMatch[] | null {
  if (raw.length < 2 || contours.length === 0 || radius < 1) return null
  if (arcLength(raw) < 6) return null

  const searchR = searchRadiusOf(radius)
  const samples = resampleCount(raw, SAMPLE_N)
  const byId = new Map(contours.map((c) => [c.id, c]))
  const hits = samples.map((p) => queryHits(p.x, p.y, searchR, contours, index))
  const masks = buildTakenMasks(byId, taken)

  const votes = new Map<number, number>()
  for (const list of hits) {
    if (masks.size > 0 && sampleOnTakenInk(list, byId, masks)) continue
    for (const hit of list) {
      if (hit.dist > searchR) continue
      const contour = byId.get(hit.contourId)
      if (!contour) continue
      if (indexTaken(masks.get(hit.contourId), hit.index, contour.points.length)) continue
      votes.set(hit.contourId, (votes.get(hit.contourId) ?? 0) + (1 - hit.dist / searchR))
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

  let best: Built | null = null
  let bestId = -1
  for (const [id, vote] of ranked) {
    if (vote < 1.2) continue
    const contour = byId.get(id)
    if (!contour) continue
    const built = matchContour(contour, samples, hits, searchR, masks.get(id))
    if (!built) continue
    if (!best || built.score > best.score) {
      best = built
      bestId = id
    }
  }
  const contour = bestId >= 0 ? byId.get(bestId) : undefined
  if (!best || !contour) return null
  return emitMatches(contour, raw, best, masks.get(contour.id))
}
