import { queryHits, sliceContour, type Contour, type SpatialIndex } from '@/lib/contours'
import {
  arcLength,
  normalize,
  orientPolyline,
  resampleCount,
  type Point,
} from '@/lib/polyline'

export type StrokeMatch = {
  /** 整笔都参与变形，长短不够就拉伸或缩短 */
  source: Point[]
  /** 同一条参考轮廓上、从笔迹起点投影到终点投影的那一段 */
  target: Point[]
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
    target = sliceContour(contour, origin, origin + (sign >= 0 ? n : -n))
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
    }
  }
  if (advance < 8) return null
  const align = meanAlign(near, target)
  if (align < 0.16 && advance < 40) return null
  if (grazes(advance, near)) return null
  const score = (searchR - mean) * picked.length + align * 10 + Math.min(advance, 1200) * 0.035
  return { target, mean, covered: picked.length, align, advance, score }
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
  return { target, mean, covered: near.length, align, advance, score }
}

function betterBuilt(a: Built | null, b: Built | null) {
  if (!a) return b
  if (!b) return a
  return b.score > a.score ? b : a
}

function matchContour(
  contour: Contour,
  samples: Point[],
  hits: Array<Array<{ contourId: number; index: number; dist: number }>>,
  searchR: number,
): Built | null {
  const obs: Obs[] = []
  for (let si = 0; si < samples.length; si++) {
    const hit = hits[si].find((h) => h.contourId === contour.id)
    if (!hit || hit.dist > searchR) continue
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

/**
 * 抬笔后只选一条参考轮廓。
 * 看整段形状和位置，不拿笔迹长度去卡目标长度。
 * 目标是这条轮廓上从起点投影走到终点投影的一段；笔伸出端点就收到轮廓为止。
 * 整笔再按弧长拉到这段上。周围没有够近的线才放弃。
 */
export function matchFinishedStroke(
  raw: Point[],
  contours: Contour[],
  index: SpatialIndex,
  radius: number,
): StrokeMatch[] | null {
  if (raw.length < 2 || contours.length === 0 || radius < 1) return null
  if (arcLength(raw) < 6) return null

  const searchR = searchRadiusOf(radius)
  const samples = resampleCount(raw, SAMPLE_N)
  const byId = new Map(contours.map((c) => [c.id, c]))
  const hits = samples.map((p) => queryHits(p.x, p.y, searchR, contours, index))

  const votes = new Map<number, number>()
  for (const list of hits) {
    for (const hit of list) {
      if (hit.dist > searchR) continue
      votes.set(hit.contourId, (votes.get(hit.contourId) ?? 0) + (1 - hit.dist / searchR))
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

  let best: Built | null = null
  for (const [id, vote] of ranked) {
    if (vote < 1.2) continue
    const contour = byId.get(id)
    if (!contour) continue
    const built = matchContour(contour, samples, hits, searchR)
    if (!built) continue
    if (!best || built.score > best.score) best = built
  }
  if (!best) return null

  const source = raw.map((p) => ({ ...p }))
  const target = orientPolyline(source, best.target)
  if (target.length < 2 || arcLength(target) < 8) return null
  return [{ source, target }]
}
