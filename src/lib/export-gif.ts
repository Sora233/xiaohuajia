import { encode, type UnencodedFrame } from 'modern-gif'

import { PAPER } from '@/lib/ink-color'
import { arcLength, easeInOutCubic, morphPolyline, slicePolylineByFraction, type Point } from '@/lib/polyline'
import type { ReplayMark, ReplayPiece, ReplayStroke, StrokePainter } from '@/lib/stroke-painter'

/** 最长边。再大的话，每帧找色和压缩都会明显变慢。 */
const MAX_EDGE = 480
/** 作画过程大约 5 秒。单位是 GIF 的百分秒。 */
const TOTAL_CS = 500
/** 画完后再停 2 秒，把成品留在画面上。 */
const END_HOLD_CS = 200
/** 再短很多浏览器会当成 0.1 秒。 */
const MIN_FRAME_CS = 2

type Frame = {
  delay: number
  marks: ReplayMark[]
}

type ShotPlan = {
  draw: number
  morph: number
  frameCs: number
  /** 加在最后一帧上，补齐到总时长。 */
  tailCs: number
}

/** 笔少就多给几帧变形，笔多就缩短每笔，总和仍是大约 5 秒。 */
function planShot(strokeCount: number): ShotPlan {
  const options = [
    { draw: 2, morph: 3 },
    { draw: 1, morph: 2 },
    { draw: 1, morph: 1 },
    { draw: 0, morph: 1 },
  ]
  for (const option of options) {
    const count = (option.draw + option.morph) * strokeCount
    const frameCs = Math.floor(TOTAL_CS / count)
    if (frameCs >= MIN_FRAME_CS) {
      return { ...option, frameCs, tailCs: TOTAL_CS - frameCs * count }
    }
  }
  const frameCs = MIN_FRAME_CS
  return { draw: 0, morph: 1, frameCs, tailCs: 0 }
}

type View = {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

function nextTick() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

/** 按弧长把这一笔的源线段逐段露出来，顺序就是落笔顺序。 */
function revealSources(pieces: ReplayPiece[], t: number): Point[][] {
  const lengths = pieces.map((piece) => Math.max(arcLength(piece.source), 1))
  const total = lengths.reduce((sum, len) => sum + len, 0)
  let remain = Math.max(0, Math.min(1, t)) * total
  const lines: Point[][] = []
  for (let i = 0; i < pieces.length; i++) {
    if (remain <= 0.5) break
    if (remain >= lengths[i] - 0.5) {
      lines.push(pieces[i].source)
      remain -= lengths[i]
      continue
    }
    lines.push(slicePolylineByFraction(pieces[i].source, 0, remain / lengths[i]))
    break
  }
  if (lines.length === 0 && pieces[0]?.source[0]) lines.push([{ ...pieces[0].source[0] }])
  return lines
}

/**
 * 只含当前这一笔。已经变形完的笔画在底图上，不必每帧重画。
 * delay 用毫秒，和 modern-gif 一致。
 */
function framesForStroke(stroke: ReplayStroke, plan: ShotPlan): Frame[] {
  const delay = plan.frameCs * 10
  const frames: Frame[] = []
  for (let step = 1; step <= plan.draw; step++) {
    frames.push({
      delay,
      marks: [{ lines: revealSources(stroke.pieces, step / plan.draw), width: stroke.width }],
    })
  }
  for (let step = 1; step <= plan.morph; step++) {
    const done = step === plan.morph
    frames.push({
      delay,
      marks: [
        {
          lines: done
            ? stroke.pieces.map((piece) => piece.target)
            : stroke.pieces.map((piece) =>
                morphPolyline(piece.source, piece.target, easeInOutCubic(step / plan.morph)),
              ),
          hints: done ? undefined : stroke.pieces.map((piece) => piece.target),
          width: stroke.width,
        },
      ],
    })
  }
  return frames
}

/** 围着有效笔画取景，小范围的笔也能放大到看得清变形。 */
function viewOf(strokes: ReplayStroke[], width: number, height: number): View {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (point: Point) => {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  for (const stroke of strokes) {
    for (const piece of stroke.pieces) {
      for (const point of piece.source) add(point)
      for (const point of piece.target) add(point)
    }
  }
  const pad = 40
  const x = Math.max(0, minX - pad)
  const y = Math.max(0, minY - pad)
  const right = Math.min(width, maxX + pad)
  const bottom = Math.min(height, maxY + pad)
  const viewW = Math.max(1, right - x)
  const viewH = Math.max(1, bottom - y)
  const scale = Math.min(2, MAX_EDGE / Math.max(viewW, viewH))
  return { x, y, width: viewW, height: viewH, scale }
}

/** 按作画顺序把有效笔画和它们的变形收成一张循环 GIF。没有有效笔画时返回 null。 */
export async function buildReplayGif(painter: StrokePainter): Promise<Blob | null> {
  const width = painter.width
  const height = painter.height
  const strokes = painter.replayStrokes()
  if (width < 2 || height < 2 || strokes.length === 0) return null

  const view = viewOf(strokes, width, height)
  const outW = Math.max(1, Math.round(view.width * view.scale))
  const outH = Math.max(1, Math.round(view.height * view.scale))
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持画布')

  const base = document.createElement('canvas')
  base.width = outW
  base.height = outH
  const baseCtx = base.getContext('2d')
  if (!baseCtx) throw new Error('当前浏览器不支持画布')
  baseCtx.fillStyle = PAPER
  baseCtx.fillRect(0, 0, outW, outH)

  const frames: UnencodedFrame[] = []
  const plan = planShot(strokes.length)
  for (let s = 0; s < strokes.length; s++) {
    const shot = framesForStroke(strokes[s], plan)
    if (s === strokes.length - 1 && shot.length > 0) {
      shot[shot.length - 1].delay += (plan.tailCs + END_HOLD_CS) * 10
    }
    for (const frame of shot) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(base, 0, 0)
      ctx.setTransform(view.scale, 0, 0, view.scale, -view.x * view.scale, -view.y * view.scale)
      painter.paintReplay(ctx, frame.marks)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const pixels = ctx.getImageData(0, 0, outW, outH)
      const data = new Uint8ClampedArray(new ArrayBuffer(pixels.data.length))
      data.set(pixels.data)
      frames.push({
        data,
        delay: frame.delay,
        // 关掉整帧透明，库才会只压和上一帧不同的那一块
        transparent: false,
      } as UnencodedFrame)
    }
    baseCtx.setTransform(view.scale, 0, 0, view.scale, -view.x * view.scale, -view.y * view.scale)
    painter.paintReplay(baseCtx, shot[shot.length - 1].marks)
    baseCtx.setTransform(1, 0, 0, 1, 0, 0)
    await nextTick()
  }

  return encode({
    width: outW,
    height: outH,
    frames,
    maxColors: 255,
    format: 'blob',
    looped: true,
    loopCount: 0,
  })
}
