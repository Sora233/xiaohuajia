import { takeTraceTimings, type Contour, type SpatialIndex, type TraceTimings } from '@/lib/contours'
import { indexInkOutlines, traceInkOutlines } from '@/lib/ink-outline'

export type ExtractionTimings = {
  mask: number
  thin: number
  trace: number
  index: number
  total: number
  traceDetail: TraceTimings | null
}

export type ExtractionResult = {
  contours: Contour[]
  index: SpatialIndex
  timings: ExtractionTimings
}

/** 灰度拉对比、阈值取墨，再沿墨块边界描线。不碰 DOM，可在 Worker 里跑。 */
export function runExtraction(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  detail: number,
): ExtractionResult {
  const t0 = performance.now()
  const contours = traceInkOutlines(rgba, width, height, detail)
  const tTrace = performance.now()
  const index = indexInkOutlines(contours, width, height)
  const tIndex = performance.now()
  return {
    contours,
    index,
    timings: {
      mask: tTrace - t0,
      thin: 0,
      trace: tTrace - t0,
      index: tIndex - tTrace,
      total: tIndex - t0,
      traceDetail: takeTraceTimings(),
    },
  }
}
