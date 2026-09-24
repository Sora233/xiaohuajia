import { buildSpatialIndex, traceContours } from '@/lib/contours'
import { matchFinishedStroke } from '@/lib/match-stroke'
import { arcLength } from '@/lib/polyline'

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

// 直角：两条边不要因为共点被焊成一条平滑线（拐角应断开或至少保留尖角）
{
  const img = blank(w, h)
  hline(img, w, 10, 70, 20)
  vline(img, w, 70, 20, 65)
  const contours = summarize('L 形', img, w, h)
  assert(contours.length >= 1, 'L 形丢失')
  const total = contours.reduce((s, c) => s + arcLength(c.points), 0)
  assert(total > 90, 'L 形总长太短')
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
  assert(matched && matched.length >= 1, '跨线笔没有匹配')
  const covered = matched.reduce((s, m) => s + arcLength(m.target), 0)
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

// 一笔沿横线再转入竖线：两条轮廓都要被盖住
{
  const img = blank(w, h)
  hline(img, w, 8, 96, 16)
  vline(img, w, 52, 16, 68)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = []
  for (let x = 12; x <= 52; x += 3) raw.push({ x, y: 16 + Math.sin(x / 3) * 4 })
  for (let y = 18; y <= 64; y += 3) raw.push({ x: 52 + Math.sin(y / 2) * 4, y })
  const matched = matchFinishedStroke(raw, contours, index, 26)
  assert(matched && matched.length >= 1, 'T 形跨线没有匹配')
  const covered = matched.reduce((s, m) => s + arcLength(m.target), 0)
  console.log(
    'T 跨线',
    matched.length,
    '覆盖',
    Math.round(covered),
    '轮廓',
    contours.map((c) => Math.round(arcLength(c.points))).join(','),
  )
  assert(covered > 70, `T 形跨线覆盖太短：${covered.toFixed(1)}`)
  const target = matched.flatMap((m) => m.target)
  const minY = Math.min(...target.map((p) => p.y))
  const maxY = Math.max(...target.map((p) => p.y))
  const minX = Math.min(...target.map((p) => p.x))
  const maxX = Math.max(...target.map((p) => p.x))
  assert(maxX - minX > 30 && maxY - minY > 30, 'T 形跨线没有同时包含横线和竖线')
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

console.log('contour self-check ok')
