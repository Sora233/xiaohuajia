import { buildSpatialIndex, takeTraceTimings, traceContours } from '@/lib/contours'
import { matchFinishedStroke } from '@/lib/match-stroke'
import { arcLength, resampleSpacing } from '@/lib/polyline'

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message)
}

function blank(w: number, h: number) {
  return new Uint8Array(w * h)
}

function plot(img: Uint8Array, w: number, x: number, y: number) {
  if (x < 0 || y < 0 || x >= w) return
  img[y * w + x] = 1
}

function hline(img: Uint8Array, w: number, x0: number, x1: number, y: number) {
  for (let x = x0; x <= x1; x++) plot(img, w, x, y)
}

function vline(img: Uint8Array, w: number, x: number, y0: number, y1: number) {
  for (let y = y0; y <= y1; y++) plot(img, w, x, y)
}

function summarize(label: string, skel: Uint8Array, w: number, h: number) {
  const contours = traceContours(skel, w, h)
  const lens = contours.map((c) => Math.round(arcLength(c.points))).sort((a, b) => b - a)
  console.log(label, '条数', contours.length, '长度', lens.join(','), '闭合', contours.map((c) => c.closed).join(','))
  return contours
}

const w = 120
const h = 80

// 十字：对向分支应接成横、竖两条长线，而不是四段短线
{
  const img = blank(w, h)
  hline(img, w, 8, 100, 30)
  vline(img, w, 54, 8, 62)
  const contours = summarize('十字', img, w, h)
  assert(contours.length === 2, `十字应是 2 条，实际 ${contours.length}`)
  const ordered = contours.slice().sort((a, b) => arcLength(b.points) - arcLength(a.points))
  assert(arcLength(ordered[0].points) > 80, '十字长边太短')
  assert(arcLength(ordered[1].points) > 45, '十字短边太短')
}

// T 形：横线穿过结点保持一整条
{
  const img = blank(w, h)
  hline(img, w, 6, 100, 24)
  vline(img, w, 50, 24, 60)
  const contours = summarize('T 形', img, w, h)
  const horizontal = contours.find((c) => {
    const a = c.points[0]
    const b = c.points[c.points.length - 1]
    return Math.abs(a.y - 24) < 3 && Math.abs(b.y - 24) < 3 && Math.abs(a.x - b.x) > 70
  })
  assert(horizontal, 'T 形横线没有接成一条')
  assert(arcLength(horizontal.points) > 80, 'T 形横线太短')
}

// 直角共点：本来就是一条连续骨架，应保持为一条线
{
  const img = blank(w, h)
  hline(img, w, 10, 70, 20)
  vline(img, w, 70, 20, 65)
  const contours = summarize('L 形', img, w, h)
  assert(contours.length === 1, `L 形应是 1 条，实际 ${contours.length}`)
  assert(arcLength(contours[0].points) > 90, 'L 形总长太短')
}

// 中间断开 8px，并带一根短毛刺：应接成一条长线，毛刺被丢掉
{
  const img = blank(w, h)
  hline(img, w, 5, 40, 40)
  hline(img, w, 49, 110, 40)
  vline(img, w, 20, 28, 40)
  const contours = summarize('缺口+毛刺', img, w, h)
  const main = contours.slice().sort((a, b) => arcLength(b.points) - arcLength(a.points))[0]
  const ends = [main.points[0], main.points[main.points.length - 1]]
  console.log('缺口主线端点', ends)
  const xs = ends.map((p) => p.x)
  assert(Math.min(...xs) < 10 && Math.max(...xs) > 100, '缺口没有把整段接上')
  assert(arcLength(main.points) > 95, '接上之后的线太短')
}

// 整笔晃线应覆盖长轮廓的绝大部分，而不是一小段
{
  const img = blank(w, h)
  hline(img, w, 4, 112, 50)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = []
  for (let x = 8; x <= 108; x += 3) {
    raw.push({ x, y: 50 + Math.sin(x / 5) * 8 })
  }
  const matched = matchFinishedStroke(raw, contours, index, 28)
  assert(matched && matched.length === 1, '长晃线没有匹配到一条目标')
  const targetLen = arcLength(matched[0].target)
  console.log('长晃线目标长', Math.round(targetLen), '源长', Math.round(arcLength(matched[0].source)))
  assert(targetLen > 85, `长晃线只得到很短的一段：${targetLen.toFixed(1)}`)
}

// 一笔跨过直角两边
{
  const img = blank(w, h)
  hline(img, w, 8, 60, 18)
  vline(img, w, 60, 18, 68)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = []
  for (let x = 12; x <= 58; x += 3) raw.push({ x, y: 18 + Math.sin(x) * 3 })
  for (let y = 20; y <= 64; y += 3) raw.push({ x: 60 + Math.sin(y / 2) * 3, y })
  const matched = matchFinishedStroke(raw, contours, index, 24)
  assert(matched && matched.length === 1, `跨线笔应只有一条目标，实际 ${matched?.length ?? 0}`)
  const covered = arcLength(matched[0].target)
  console.log(
    '跨线目标',
    matched.length,
    '覆盖',
    Math.round(covered),
    '轮廓数',
    contours.length,
  )
  assert(covered > 80, `跨线覆盖太短：${covered.toFixed(1)}`)
}

// T 形仍是横、竖两条。一笔只顺着横线走，就只得到那一条，不会把竖线也焊进来
{
  const img = blank(w, h)
  hline(img, w, 8, 96, 16)
  vline(img, w, 52, 16, 68)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = []
  for (let x = 12; x <= 90; x += 3) raw.push({ x, y: 16 + Math.sin(x / 3) * 4 })
  const matched = matchFinishedStroke(raw, contours, index, 26)
  assert(matched && matched.length === 1, `T 形横线应只有一条目标，实际 ${matched?.length ?? 0}`)
  const covered = arcLength(matched[0].target)
  console.log(
    'T 横线',
    matched.length,
    '覆盖',
    Math.round(covered),
    '轮廓',
    contours.map((c) => Math.round(arcLength(c.points))).join(','),
  )
  assert(covered > 60, `T 形横线覆盖太短：${covered.toFixed(1)}`)
  const ys = matched[0].target.map((p) => p.y)
  assert(Math.max(...ys) - Math.min(...ys) < 18, 'T 形横线被带进了竖线')
}

// 离线太远应放弃
{
  const img = blank(w, h)
  hline(img, w, 10, 80, 10)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = []
  for (let x = 10; x <= 80; x += 4) raw.push({ x, y: 60 })
  const matched = matchFinishedStroke(raw, contours, index, 20)
  assert(matched === null, '远离轮廓的笔不应匹配')
}

// 大量虚线：旧的全对全补缺会到秒级甚至卡住。这里必须很快，并且仍能接成长线。
{
  const W = 800
  const H = 480
  const img = blank(W, H)
  for (let y = 8; y < H - 8; y += 14) {
    for (let x = 4; x < W - 28; x += 26) hline(img, W, x, x + 19, y)
  }
  for (let x = 70; x < W - 8; x += 140) vline(img, W, x, 8, H - 10)
  const t0 = performance.now()
  const contours = traceContours(img, W, H)
  const ms = performance.now() - t0
  const timings = takeTraceTimings()
  const longest = contours.reduce((m, c) => Math.max(m, arcLength(c.points)), 0)
  console.log(
    '压力耗时',
    Math.round(ms),
    '边',
    timings?.edges,
    '补缺',
    timings?.bridge,
    '轮廓',
    contours.length,
    '最长',
    Math.round(longest),
  )
  assert((timings?.edges ?? 0) > 400, '压力图没有留下足够碎片，补缺没有被测到')
  assert(ms < 500, `轮廓提取过慢：${ms.toFixed(0)}ms`)
  assert((timings?.bridge ?? 999) < 200, `补缺过慢：${timings?.bridge}ms`)
  assert(longest > 200, `压力图没有接出长线：${longest.toFixed(0)}`)
}

function coverRatio(refPts: { x: number; y: number }[], targets: { x: number; y: number }[], tol = 14) {
  const samples = resampleSpacing(refPts, 4)
  if (samples.length === 0 || targets.length === 0) return 0
  const tol2 = tol * tol
  let hit = 0
  for (const p of samples) {
    for (const t of targets) {
      if ((t.x - p.x) ** 2 + (t.y - p.y) ** 2 <= tol2) {
        hit++
        break
      }
    }
  }
  return hit / samples.length
}

function wobble(pts: { x: number; y: number }[], amp = 6) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    const w = Math.sin(i / 3.2) * amp
    return { x: p.x + (-dy / l) * w, y: p.y + (dx / l) * w }
  })
}

// 三条边在拐角处断开十几像素：应接成一条线，一笔绕过去只得到这一条，并且盖住描过的范围
{
  const W = 360
  const H = 260
  const img = blank(W, H)
  hline(img, W, 30, 200, 40)
  vline(img, W, 210, 50, 184)
  hline(img, W, 30, 200, 194)
  const ref = []
  for (let x = 30; x <= 200; x += 4) ref.push({ x, y: 40 })
  for (let y = 40; y <= 194; y += 4) ref.push({ x: 210, y })
  for (let x = 200; x >= 30; x -= 4) ref.push({ x, y: 194 })
  const contours = traceContours(img, W, H)
  const index = buildSpatialIndex(contours, W, H)
  const raw = wobble(ref, 5)
  const matched = matchFinishedStroke(raw, contours, index, 28)
  const targets = matched ? matched[0].target : []
  const cover = coverRatio(ref, targets, 16)
  const outLen = matched ? arcLength(matched[0].target) : 0
  const refLen = arcLength(ref)
  console.log(
    '拐角跨线',
    '轮廓',
    contours.length,
    '段',
    matched?.length ?? 0,
    '覆盖',
    cover.toFixed(2),
    '输出',
    Math.round(outLen),
    '参考',
    Math.round(refLen),
    '长度比',
    refLen ? (outLen / refLen).toFixed(2) : '0',
  )
  assert(contours.length === 1, `断开的直角没有接成一条，实际 ${contours.length}`)
  assert(matched && matched.length === 1, '绕框的一笔不应分成多条目标')
  assert(cover >= 0.85, `绕框覆盖不够：${cover.toFixed(2)}`)
  assert(outLen >= refLen * 0.85, `绕框输出比描过的范围短：${outLen.toFixed(0)} / ${refLen.toFixed(0)}`)
}

// 一条长线上隔开的几段：整笔都要留下来
{
  const W = 520
  const H = 80
  const img = blank(W, H)
  for (let x0 = 10; x0 < 460; x0 += 90) hline(img, W, x0, x0 + 58, 40)
  const ref = []
  for (let x0 = 10; x0 < 460; x0 += 90) {
    for (let x = x0; x <= x0 + 58; x += 4) ref.push({ x, y: 40 })
  }
  const guide = []
  for (let x = 10; x <= 500; x += 4) guide.push({ x, y: 40 })
  const contours = traceContours(img, W, H)
  const index = buildSpatialIndex(contours, W, H)
  const raw = wobble(guide, 4)
  const matched = matchFinishedStroke(raw, contours, index, 32)
  const targets = matched ? matched[0].target : []
  const cover = coverRatio(ref, targets, 12)
  const outLen = matched ? arcLength(matched[0].target) : 0
  const dashLen = 5 * 58
  console.log(
    '虚线长笔',
    '轮廓',
    contours.length,
    '段',
    matched?.length ?? 0,
    '覆盖',
    cover.toFixed(2),
    '输出',
    Math.round(outLen),
    '线段',
    dashLen,
  )
  assert(matched && matched.length === 1, '虚线长笔应合成一条目标')
  assert(contours.length === 1, `共线虚线没有接成一条，实际 ${contours.length}`)
  assert(cover >= 0.85, `虚线长笔覆盖不够：${cover.toFixed(2)}`)
  assert(outLen > dashLen * 0.85, `虚线长笔的输出比描过的线段短太多：${outLen.toFixed(0)}`)
}

console.log('contour self-check ok')
