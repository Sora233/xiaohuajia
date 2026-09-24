import { buildSpatialIndex, takeTraceTimings, traceContours } from '@/lib/contours'
import { runExtraction } from '@/lib/extract'
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

// 偏出几十像素、两端伸出轮廓：长度不必一样，整笔仍应吸上这一条
{
  const img = blank(w, h)
  hline(img, w, 24, 96, 18)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = []
  for (let x = -20; x <= 150; x += 4) {
    raw.push({ x, y: 18 + 42 + Math.sin(x / 5) * 7 })
  }
  const matched = matchFinishedStroke(raw, contours, index, 36)
  assert(matched && matched.length === 1, '偏移加伸出的长笔应匹配到一条')
  const targetLen = arcLength(matched[0].target)
  const sourceLen = arcLength(matched[0].source)
  console.log('偏移伸出', '目标', Math.round(targetLen), '源', Math.round(sourceLen))
  assert(targetLen > 60, `偏移伸出的目标太短：${targetLen.toFixed(1)}`)
  assert(Math.abs(sourceLen - arcLength(raw)) < 1, '源应保留整笔，不能按长度裁掉')
}

// 默认容差下大约 48px 的平行偏移要吸上；半径 20 时同样的距离应淡出
{
  const img = blank(w, h)
  hline(img, w, 8, 100, 16)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = []
  for (let x = 8; x <= 100; x += 4) raw.push({ x, y: 16 + 48 })
  const near = matchFinishedStroke(raw, contours, index, 36)
  const far = matchFinishedStroke(raw, contours, index, 20)
  assert(near && near.length === 1 && arcLength(near[0].target) > 70, '48px 偏移在默认容差下应吸上')
  assert(far === null, '半径 20 时 48px 以上的偏移应淡出')
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

function rangesOverlap(a: Array<[number, number]>, b: Array<[number, number]>) {
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      if (Math.max(a0, b0) <= Math.min(a1, b1)) return true
    }
  }
  return false
}

function spansOf(matched: Array<{ spans: Array<[number, number]> }>) {
  return matched.flatMap((piece) => piece.spans)
}

function wobbleLine(x0: number, x1: number, y: number, step = 3) {
  const raw = []
  const dir = x0 <= x1 ? 1 : -1
  for (let x = x0; dir > 0 ? x <= x1 : x >= x1; x += dir * step) {
    raw.push({ x, y: y + Math.sin(x / 5) * 6 })
  }
  return raw
}

// 已经画过的整段，再描一次不应再匹配
{
  const img = blank(w, h)
  hline(img, w, 4, 112, 50)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const raw = wobbleLine(8, 108, 50)
  const first = matchFinishedStroke(raw, contours, index, 28)
  assert(first && first.length === 1, '第一笔应匹配到线')
  const again = matchFinishedStroke(raw, contours, index, 28, first)
  console.log('重复描线', again?.length ?? 0)
  assert(again === null, '已经画上去的线不应再次匹配')
}

// 先画左半，再描整条：第二次只补右半，不覆盖左半
{
  const img = blank(w, h)
  hline(img, w, 4, 112, 50)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const left = wobbleLine(8, 58, 50)
  const full = wobbleLine(8, 108, 50)
  const first = matchFinishedStroke(left, contours, index, 28)
  assert(first && first.length === 1, '左半笔没有匹配')
  const second = matchFinishedStroke(full, contours, index, 28, first)
  const leftMax = Math.max(...first[0].target.map((p) => p.x))
  const secondMin = second ? Math.min(...second.flatMap((p) => p.target.map((t) => t.x))) : 0
  const secondMax = second ? Math.max(...second.flatMap((p) => p.target.map((t) => t.x))) : 0
  console.log(
    '补右半',
    second?.length ?? 0,
    '左端',
    Math.round(leftMax),
    '新段',
    Math.round(secondMin),
    Math.round(secondMax),
    '重叠',
    second ? rangesOverlap(spansOf(first), spansOf(second)) : false,
  )
  assert(second && second.length >= 1, '右半还应匹配到')
  assert(!rangesOverlap(spansOf(first), spansOf(second)), '新目标与已画段落重叠')
  assert(secondMin >= leftMax - 3, `新段又回到了已画的左半：${secondMin.toFixed(1)} / ${leftMax.toFixed(1)}`)
  assert(secondMax > leftMax + 30, '右半没有补上')
}

// 中间已经画过：整笔跨过去时拆成左右两段，中间不再匹配
{
  const img = blank(w, h)
  hline(img, w, 4, 112, 50)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const mid = wobbleLine(46, 74, 50)
  const full = wobbleLine(8, 108, 50)
  const first = matchFinishedStroke(mid, contours, index, 28)
  assert(first && first.length === 1, '中间一笔没有匹配')
  const second = matchFinishedStroke(full, contours, index, 28, first)
  const midMin = Math.min(...first[0].target.map((p) => p.x))
  const midMax = Math.max(...first[0].target.map((p) => p.x))
  const bands = (second ?? [])
    .map((p) => ({
      min: Math.min(...p.target.map((t) => t.x)),
      max: Math.max(...p.target.map((t) => t.x)),
    }))
    .sort((a, b) => a.min - b.min)
  console.log(
    '跨过中间',
    second?.length ?? 0,
    '中段',
    Math.round(midMin),
    Math.round(midMax),
    '新段',
    bands.map((b) => `${Math.round(b.min)}-${Math.round(b.max)}`).join(','),
    '重叠',
    second ? rangesOverlap(spansOf(first), spansOf(second)) : false,
  )
  assert(second && second.length === 2, `跨过已画段应留下左右两段，实际 ${second?.length ?? 0}`)
  assert(!rangesOverlap(spansOf(first), spansOf(second)), '左右两段碰到了已画的中间')
  assert(bands[0].max < midMin + 4, '左段伸进了已画的中间')
  assert(bands[1].min > midMax - 4, '右段伸进了已画的中间')
}

// 横线画过之后，竖线仍能匹配
{
  const img = blank(w, h)
  hline(img, w, 8, 96, 16)
  vline(img, w, 52, 16, 68)
  const contours = traceContours(img, w, h)
  const index = buildSpatialIndex(contours, w, h)
  const horizontal = []
  for (let x = 12; x <= 90; x += 3) horizontal.push({ x, y: 16 + Math.sin(x / 3) * 4 })
  const vertical = []
  for (let y = 20; y <= 64; y += 3) vertical.push({ x: 52 + Math.sin(y / 2) * 3, y })
  const across = matchFinishedStroke(horizontal, contours, index, 26)
  assert(across && across.length === 1, '横线没有先匹配上')
  const down = matchFinishedStroke(vertical, contours, index, 26, across)
  const downLen = down ? arcLength(down[0].target) : 0
  console.log('画过横线后再画竖线', down?.length ?? 0, '长', Math.round(downLen))
  assert(down && down.length === 1, '另一条线不应因为旁边已经画过就被丢掉')
  assert(downLen > 30, `竖线剩下的太短：${downLen.toFixed(1)}`)
  const xs = down[0].target.map((p) => p.x)
  assert(Math.max(...xs) - Math.min(...xs) < 18, '竖线被带进了已经画过的横线')
  if (down[0].contourId === across[0].contourId) {
    assert(!rangesOverlap(spansOf(across), spansOf(down)), '竖线匹配进了已经画过的横线')
  }
}

function paper(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = 255
  }
  return data
}

function inkAt(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const i = (y * width + x) * 4
  data[i] = 0
  data[i + 1] = 0
  data[i + 2] = 0
}

function lengthsOf(contours: Array<{ points: { x: number; y: number }[] }>) {
  return contours.map((c) => arcLength(c.points)).sort((a, b) => b - a)
}

// 粗线应收成一条中心线，而不是并排的两条边
{
  const W = 160
  const H = 80
  const data = paper(W, H)
  for (let x = 12; x <= 140; x++) {
    for (let t = 0; t < 4; t++) inkAt(data, W, x, 36 + t)
  }
  const { contours } = runExtraction(data, W, H, 62)
  const lens = lengthsOf(contours)
  console.log('粗线中心', '条数', contours.length, '长度', lens.map((n) => Math.round(n)).join(','))
  assert(contours.length <= 2, `4px 粗线裂成了太多条：${contours.length}`)
  assert(lens[0] > 90 && lens[0] < 180, `4px 粗线没有收到中心线：${lens[0]?.toFixed(0)}`)
}

// 实心块取外边界，不抽成一根短脊
{
  const W = 100
  const H = 80
  const data = paper(W, H)
  for (let y = 16; y < 56; y++) {
    for (let x = 20; x < 70; x++) inkAt(data, W, x, y)
  }
  const { contours } = runExtraction(data, W, H, 62)
  const lens = lengthsOf(contours)
  const total = lens.reduce((s, n) => s + n, 0)
  console.log('实心块', '条数', contours.length, '长度', lens.map((n) => Math.round(n)).join(','))
  assert(contours.length <= 3, `实心块轮廓太多：${contours.length}`)
  assert(lens[0] > 140 && lens[0] < 240, `实心块边界长度不对：${lens[0]?.toFixed(0)}`)
  assert(total < 420, `实心块骨架太碎：${total.toFixed(0)}`)
}

// 成片网点只留一块外轮廓
{
  const W = 130
  const H = 100
  const data = paper(W, H)
  for (let y = 14; y <= 78; y += 6) {
    for (let x = 16; x <= 108; x += 6) {
      inkAt(data, W, x, y)
      inkAt(data, W, x + 1, y)
      inkAt(data, W, x, y + 1)
      inkAt(data, W, x + 1, y + 1)
    }
  }
  const { contours } = runExtraction(data, W, H, 62)
  const lens = lengthsOf(contours)
  console.log('网点', '条数', contours.length, '长度', lens.map((n) => Math.round(n)).join(','))
  assert(contours.length <= 3, `网点被拆成很多条：${contours.length}`)
  assert(lens[0] > 160, `网点没有留下外轮廓：${lens[0]?.toFixed(0)}`)
}

// 3px 粗线中间断开约 24px，两边都够长时应接成一条
{
  const W = 180
  const H = 70
  const data = paper(W, H)
  for (let x = 8; x <= 70; x++) {
    for (let t = 0; t < 3; t++) inkAt(data, W, x, 30 + t)
  }
  for (let x = 95; x <= 168; x++) {
    for (let t = 0; t < 3; t++) inkAt(data, W, x, 30 + t)
  }
  const { contours } = runExtraction(data, W, H, 62)
  const main = contours.slice().sort((a, b) => arcLength(b.points) - arcLength(a.points))[0]
  const xs = main ? [main.points[0].x, main.points[main.points.length - 1].x] : [0, 0]
  console.log(
    '宽缺口',
    '条数',
    contours.length,
    '长度',
    lengthsOf(contours).map((n) => Math.round(n)).join(','),
    '端点',
    xs.map((n) => Math.round(n)).join(','),
  )
  assert(main && Math.min(...xs) < 16 && Math.max(...xs) > 155, '24px 共线缺口没有接上')
}

// 相距 16px 的平行线保持两条，不能被闭运算或补缺焊在一起
{
  const W = 180
  const H = 70
  const data = paper(W, H)
  for (let x = 10; x <= 160; x++) {
    for (let t = 0; t < 3; t++) {
      inkAt(data, W, x, 18 + t)
      inkAt(data, W, x, 34 + t)
    }
  }
  const { contours } = runExtraction(data, W, H, 62)
  const lens = lengthsOf(contours)
  console.log('平行线', '条数', contours.length, '长度', lens.map((n) => Math.round(n)).join(','))
  const longs = lens.filter((n) => n > 80)
  assert(longs.length >= 2, `16px 平行线被并成了一条：${lens.map((n) => Math.round(n)).join(',')}`)
}

console.log('contour self-check ok')
