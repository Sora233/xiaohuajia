import {
  buildSpatialIndex,
  takeTraceTimings,
  thinSkeleton,
  traceContours,
  type Contour,
  type SpatialIndex,
  type TraceTimings,
} from '@/lib/contours'

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

function gaussianBlur5(src: Float32Array, width: number, height: number): Float32Array {
  // 可分离 5-tap 近似高斯核
  const kernel = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136]
  const tmp = new Float32Array(width * height)
  const out = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k))
        acc += src[row + xx] * kernel[k + 2]
      }
      tmp[row + x] = acc
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k))
        acc += tmp[yy * width + x] * kernel[k + 2]
      }
      out[y * width + x] = acc
    }
  }
  return out
}

/**
 * 从 RGBA 像素提取二值线掩膜：照片用 Sobel 边，线稿只用深色墨迹。
 * `detail`：0–100，越大保留越弱的边。
 */
export function extractMaskFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  detail: number,
): Uint8Array {
  const n = width * height
  const gray = new Float32Array(n)

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }

  const blurred = gaussianBlur5(gray, width, height)
  const mag = new Float32Array(n)
  let maxMag = 1
  let meanGray = 0

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx =
        -blurred[i - width - 1] +
        blurred[i - width + 1] -
        2 * blurred[i - 1] +
        2 * blurred[i + 1] -
        blurred[i + width - 1] +
        blurred[i + width + 1]
      const gy =
        -blurred[i - width - 1] -
        2 * blurred[i - width] -
        blurred[i - width + 1] +
        blurred[i + width - 1] +
        2 * blurred[i + width] +
        blurred[i + width + 1]
      const m = Math.hypot(gx, gy)
      mag[i] = m
      if (m > maxMag) maxMag = m
    }
  }

  for (let i = 0; i < n; i++) meanGray += blurred[i]
  meanGray /= n

  const looksLikeLineArt = meanGray > 150
  const tNorm = Math.min(100, Math.max(0, detail)) / 100
  const edgeT = maxMag * (0.4 - tNorm * 0.34)
  const inkT = looksLikeLineArt ? 176 : 108 + (1 - tNorm) * 42

  const mark = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const edge = mag[i] >= edgeT
    const ink = blurred[i] < inkT
    // 线稿只用墨迹，避免 Sobel 把每条线描成双边再撕碎骨架
    mark[i] = looksLikeLineArt ? (ink ? 1 : 0) : edge ? 1 : 0
  }
  return mark
}

/** 掩膜 → 细化 → 长轮廓 → 空间索引。不碰 DOM，可在 Worker 里跑。 */
export function runExtraction(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  detail: number,
): ExtractionResult {
  const t0 = performance.now()
  const mask = extractMaskFromRgba(rgba, width, height, detail)
  const tMask = performance.now()
  const skel = thinSkeleton(mask, width, height)
  const tThin = performance.now()
  const contours = traceContours(skel, width, height)
  const tTrace = performance.now()
  const index = buildSpatialIndex(contours, width, height)
  const tIndex = performance.now()
  return {
    contours,
    index,
    timings: {
      mask: tMask - t0,
      thin: tThin - tMask,
      trace: tTrace - tThin,
      index: tIndex - tTrace,
      total: tIndex - t0,
      traceDetail: takeTraceTimings(),
    },
  }
}
