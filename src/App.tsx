import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { ImageModal } from '@/components/ImageModal'
import { Toolbar } from '@/components/Toolbar'
import { Button } from '@/components/ui/button'
import {
  loadHtmlImage,
  processSource,
  ProcessingCancelled,
  type ProcessedImage,
} from '@/lib/image-process'
import { buildReplayGif } from '@/lib/export-gif'
import { renderLineSheet } from '@/lib/line-preview'
import { SAMPLE_IMAGE_SRC } from '@/lib/sample'
import { pointerToCanvas, StrokePainter } from '@/lib/stroke-painter'
import { cn } from '@/lib/utils'

/** 线条细节固定为 50，页面上不再提供调节。 */
const LINE_DETAIL = 50
/** 原图单独停留，处理期间已经看过的时间会扣掉。 */
const ORIGINAL_HOLD_MS = 700
/** 原图过渡成参考图，时间拉长，变化才看得清。 */
const MORPH_MS = 2400
/** 参考图停稳后再开始缩小。 */
const LINE_SETTLE_MS = 400
const LINE_SHRINK_MS = 1600
const MORPH_EASE = 'cubic-bezier(0.45, 0.05, 0.55, 0.95)'

type Phase = 'pick' | 'lines' | 'draw'
type Box = { left: number; top: number; width: number; height: number }
type ModalKind = 'original' | 'lines'
type Flyer = {
  from: Box
  to: Box | null
  run: boolean
  fading: boolean
}

function stageStyle(width: number, height: number): CSSProperties {
  const ratio = width / Math.max(1, height)
  return {
    aspectRatio: `${width} / ${height}`,
    width: `min(100%, calc(76vh * ${ratio}))`,
  }
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 手机和平板才出分享。电脑上没有微信、QQ 的系统分享入口。 */
function isMobileDevice() {
  const ua = navigator.userAgent
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

const GIF_FILE_NAME = '小画家模拟器.gif'

function App() {
  const fileRef = useRef<HTMLInputElement>(null)
  const resultRef = useRef<HTMLCanvasElement>(null)
  const rawRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const painterRef = useRef(new StrokePainter())
  const objectUrlRef = useRef<string | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const drawingRef = useRef(false)
  const frameRef = useRef<HTMLElement>(null)
  const refBtnRef = useRef<HTMLSpanElement>(null)
  const resetDrawRef = useRef(false)
  const colorRef = useRef(true)
  const ingestGen = useRef(0)
  const introGen = useRef(0)
  const originalShownAt = useRef(0)
  const lineUrlRef = useRef('')
  const processedRef = useRef<ProcessedImage | null>(null)

  const [processed, setProcessed] = useState<ProcessedImage | null>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [colorMode, setColorMode] = useState(true)
  const [showRaw, setShowRaw] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canExportGif, setCanExportGif] = useState(false)
  const [exportingGif, setExportingGif] = useState(false)
  const [autoDrawing, setAutoDrawing] = useState(false)
  const [gifPreview, setGifPreview] = useState<{ url: string; blob: Blob } | null>(null)
  const gifPreviewRef = useRef<{ url: string; blob: Blob } | null>(null)
  const [hint, setHint] = useState('先放一张图，再顺着线条画')
  const [phase, setPhase] = useState<Phase>('pick')
  const [lineUrl, setLineUrl] = useState('')
  const [originalUrl, setOriginalUrl] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null)
  const [showReference, setShowReference] = useState(false)
  const [introId, setIntroId] = useState(0)
  const [modal, setModal] = useState<ModalKind | null>(null)
  const [flyer, setFlyer] = useState<Flyer | null>(null)

  const publishLineSheet = useCallback((image: ProcessedImage, colorize: boolean) => {
    const sheet = renderLineSheet(
      image.contours,
      image.width,
      image.height,
      colorize ? image.color : null,
    )
    const url = sheet.toDataURL('image/png')
    lineUrlRef.current = url
    setLineUrl(url)
  }, [])

  const bindPainter = useCallback((image: ProcessedImage, reset: boolean) => {
    const painter = painterRef.current
    const result = resultRef.current
    const raw = rawRef.current
    if (!result || !raw) return
    painter.attach(result, raw)
    if (reset || painter.width !== image.width || painter.height !== image.height) {
      painter.resize(image.width, image.height)
    }
    painter.setDocument({
      contours: image.contours,
      index: image.index,
      color: image.color,
    })
    painter.setColorMode(colorRef.current)
    setCanUndo(painter.canUndo())
    setCanExportGif(painter.hasReplay())
  }, [])

  const ingestImage = useCallback(
    async (img: HTMLImageElement, resetDrawing: boolean) => {
      const gen = ++ingestGen.current
      setProcessing(true)
      setError(null)
      setHint('处理中…')
      setFlyer(null)
      setModal(null)
      try {
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        await new Promise((r) => window.setTimeout(r, 0))
        if (gen !== ingestGen.current) return
        const next = await processSource(img, LINE_DETAIL)
        if (gen !== ingestGen.current) return
        imageRef.current = img
        resetDrawRef.current = resetDrawing
        processedRef.current = next
        setProcessed(next)
        setOriginalUrl(next.color.toDataURL('image/png'))
        setFrameSize({ width: next.width, height: next.height })
        publishLineSheet(next, colorRef.current)
        const lens = next.contours
          .map((c) => c.points.length)
          .sort((a, b) => b - a)
          .slice(0, 8)
        console.debug('[小画家模拟器] 轮廓', next.contours.length, '最长', lens)
        if (import.meta.env.DEV) {
          ;(window as unknown as { __xh?: { contours: typeof next.contours; painter: StrokePainter } }).__xh =
            {
              contours: next.contours,
              painter: painterRef.current,
            }
        }
        setHint(
          next.contours.length
            ? `已提取 ${next.contours.length} 条轮廓。顺着线画，抬笔后会贴上去`
            : '几乎没提取到轮廓',
        )
        setPhase('lines')
      } catch (err) {
        if (gen !== ingestGen.current || err instanceof ProcessingCancelled) return
        setError(err instanceof Error ? err.message : '处理失败')
        setHint('换一张图片再试试')
        setPhase('pick')
      } finally {
        if (gen === ingestGen.current) setProcessing(false)
      }
    },
    [publishLineSheet],
  )

  const loadFromSrc = useCallback(
    async (src: string, resetDrawing: boolean) => {
      // 打断上一次提取和还在播的预览，避免旧图缩进按钮
      ingestGen.current += 1
      const intro = ++introGen.current
      lineUrlRef.current = ''
      setLineUrl('')
      setShowReference(false)
      setFlyer(null)
      setModal(null)
      setIntroId(intro)
      try {
        const img = await loadHtmlImage(src)
        if (intro !== introGen.current) return
        const width = img.naturalWidth || img.width
        const height = img.naturalHeight || img.height
        originalShownAt.current = performance.now()
        setPreviewUrl(src)
        setFrameSize({ width, height })
        setPhase('lines')
        await ingestImage(img, resetDrawing)
      } catch (err) {
        if (intro !== introGen.current) return
        setError(err instanceof Error ? err.message : '无法读取这张图片')
        setHint('换一张图片再试试')
        setPhase('pick')
      }
    },
    [ingestImage],
  )

  const loadFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('请选择图片文件（PNG / JPG / WebP / SVG）')
        return
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      const url = URL.createObjectURL(file)
      objectUrlRef.current = url
      try {
        await loadFromSrc(url, true)
      } catch (err) {
        setError(err instanceof Error ? err.message : '无法读取这张图片')
      }
    },
    [loadFromSrc],
  )

  useEffect(() => {
    const painter = painterRef.current
    return () => {
      painter.dispose()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  useEffect(() => {
    colorRef.current = colorMode
    painterRef.current.setColorMode(colorMode)
  }, [colorMode])

  useEffect(() => {
    if (phase !== 'draw' || !processed) return
    bindPainter(processed, resetDrawRef.current)
    resetDrawRef.current = false
  }, [phase, processed, bindPainter])

  useEffect(() => {
    if (phase !== 'lines') return
    // 只跟这一轮预览走。上色开关会换线稿地址，不从这里重开
    let cancelled = false
    const timers: number[] = []
    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
      timers.push(id)
    }
    const goDraw = () => {
      const frame = frameRef.current?.getBoundingClientRect()
      if (!frame || prefersReducedMotion() || !lineUrlRef.current) {
        setPhase('draw')
        return
      }
      setFlyer({
        from: {
          left: frame.left,
          top: frame.top,
          width: frame.width,
          height: frame.height,
        },
        to: null,
        run: false,
        fading: false,
      })
      setPhase('draw')
    }
    const waitLines = () => {
      if (!lineUrlRef.current) {
        later(waitLines, 40)
        return
      }
      if (prefersReducedMotion()) {
        setShowReference(true)
        later(goDraw, 400)
        return
      }
      const seen = performance.now() - originalShownAt.current
      const holdLeft = Math.max(0, ORIGINAL_HOLD_MS - seen)
      later(() => {
        setShowReference(true)
        later(goDraw, MORPH_MS + LINE_SETTLE_MS)
      }, holdLeft)
    }
    waitLines()
    return () => {
      cancelled = true
      for (const id of timers) window.clearTimeout(id)
    }
  }, [phase, introId])

  useLayoutEffect(() => {
    if (!flyer || flyer.to || phase !== 'draw') return
    const btn = refBtnRef.current?.getBoundingClientRect()
    if (!btn) return
    setFlyer((current) =>
      current && !current.to
        ? {
            ...current,
            to: { left: btn.left, top: btn.top, width: btn.width, height: btn.height },
          }
        : current,
    )
  }, [flyer, phase])

  useEffect(() => {
    if (!flyer?.to || flyer.run || flyer.fading) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setFlyer((current) =>
          current && current.to && !current.run ? { ...current, run: true } : current,
        )
      })
    })
    return () => {
      cancelAnimationFrame(first)
      if (second) cancelAnimationFrame(second)
    }
  }, [flyer])

  useEffect(() => {
    if (!flyer?.run || flyer.fading) return
    const timer = window.setTimeout(() => {
      setFlyer((current) => (current?.run ? { ...current, fading: true } : current))
    }, LINE_SHRINK_MS + 240)
    return () => window.clearTimeout(timer)
  }, [flyer?.run, flyer?.fading])

  useEffect(() => {
    if (!flyer?.fading) return
    const timer = window.setTimeout(() => setFlyer(null), 220)
    return () => window.clearTimeout(timer)
  }, [flyer?.fading])

  useEffect(() => {
    if (!modal) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modal || exportingGif || autoDrawing) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (painterRef.current.undo()) {
          setCanUndo(painterRef.current.canUndo())
          setCanExportGif(painterRef.current.hasReplay())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal, exportingGif, autoDrawing])

  const updateCursor = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>, visible: boolean) => {
      const el = cursorRef.current
      const canvas = resultRef.current
      if (!el || !canvas) return
      const rect = canvas.getBoundingClientRect()
      el.style.left = `${event.clientX - rect.left}px`
      el.style.top = `${event.clientY - rect.top}px`
      el.style.opacity = visible ? '1' : '0'
    },
    [],
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!processed || processing || flyer || exportingGif || autoDrawing) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    const { x, y } = pointerToCanvas(event, event.currentTarget)
    painterRef.current.beginStroke(x, y)
    updateCursor(event, true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (exportingGif || autoDrawing) {
      updateCursor(event, false)
      return
    }
    updateCursor(event, true)
    if (!drawingRef.current) return
    const { x, y } = pointerToCanvas(event, event.currentTarget)
    painterRef.current.moveStroke(x, y)
  }

  const endPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    drawingRef.current = false
    painterRef.current.endStroke()
    setCanUndo(painterRef.current.canUndo())
    setCanExportGif(painterRef.current.hasReplay())
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files[0]
    if (file) void loadFile(file)
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void loadFile(file)
    event.target.value = ''
  }

  const box = stageStyle(frameSize?.width ?? processed?.width ?? 5, frameSize?.height ?? processed?.height ?? 4)
  const morphOn = showReference && !prefersReducedMotion()
  // 参考图底是不透明纸色，只淡入上层，避免两张一起变淡时中间发灰
  const referenceFade: CSSProperties = {
    opacity: showReference ? 1 : 0,
    animation: morphOn ? `xh-fade-in ${MORPH_MS}ms ${MORPH_EASE} forwards` : 'none',
  }

  const closeModal = useCallback(() => setModal(null), [])

  const closeGifPreview = useCallback(() => {
    const current = gifPreviewRef.current
    if (current) URL.revokeObjectURL(current.url)
    gifPreviewRef.current = null
    setGifPreview(null)
    setExportingGif(false)
  }, [])

  const saveGif = useCallback(() => {
    const current = gifPreviewRef.current
    if (!current) return
    const a = document.createElement('a')
    a.href = current.url
    a.download = GIF_FILE_NAME
    a.click()
  }, [])

  const shareGif = useCallback(async () => {
    const current = gifPreviewRef.current
    if (!current) return
    const file = new File([current.blob], GIF_FILE_NAME, { type: 'image/gif' })
    const payload = { files: [file], title: '小画家模拟器' }
    try {
      if (!navigator.share || (navigator.canShare && !navigator.canShare(payload))) return
      await navigator.share(payload)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : '分享失败')
    }
  }, [])

  useEffect(() => {
    if (!gifPreview) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeGifPreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gifPreview, closeGifPreview])

  useEffect(() => {
    return () => {
      const current = gifPreviewRef.current
      if (current) URL.revokeObjectURL(current.url)
    }
  }, [])

  let flyerStyle: CSSProperties | undefined
  if (flyer) {
    const { from, to } = flyer
    let transform = 'translate(0px, 0px) scale(1)'
    if (flyer.run && to && from.width > 0 && from.height > 0) {
      const dx = to.left + to.width / 2 - (from.left + from.width / 2)
      const dy = to.top + to.height / 2 - (from.top + from.height / 2)
      const scale = Math.min(to.width / from.width, to.height / from.height) * 0.92
      transform = `translate(${dx}px, ${dy}px) scale(${Math.max(0.05, scale)})`
    }
    flyerStyle = {
      left: from.left,
      top: from.top,
      width: from.width,
      height: from.height,
      transform,
      opacity: flyer.fading ? 0 : 1,
      transition: flyer.run
        ? `transform ${LINE_SHRINK_MS}ms cubic-bezier(0.45, 0, 0.15, 1), opacity 200ms ease`
        : 'none',
    }
  }

  return (
    <div
      className="mx-auto flex min-h-svh max-w-7xl flex-col gap-4 px-4 py-5 md:gap-5 md:px-6 md:py-6"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium tracking-[0.22em] text-cinnabar">
            临摹练习
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            《小画家模拟器》
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            顺着线条画。抬笔之后，笔迹会变成图上的那条线。
          </p>
        </div>
        <p className="max-w-xs text-xs leading-relaxed text-muted sm:text-right">
          离得太远的乱笔会淡出。
        </p>
      </header>

      <Toolbar
        fileRef={fileRef}
        hasImage={Boolean(processed)}
        canUndo={canUndo && !autoDrawing}
        processing={processing}
        colorMode={colorMode}
        showRaw={showRaw}
        onUploadClick={() => fileRef.current?.click()}
        onFileChange={onFileChange}
        onSample={() => {
          void loadFromSrc(SAMPLE_IMAGE_SRC, true)
        }}
        onColorMode={(on) => {
          colorRef.current = on
          setColorMode(on)
          const image = processedRef.current
          if (image) publishLineSheet(image, on)
        }}
        onShowRaw={setShowRaw}
        onUndo={() => {
          if (autoDrawing) return
          painterRef.current.undo()
          setCanUndo(painterRef.current.canUndo())
          setCanExportGif(painterRef.current.hasReplay())
        }}
        onClear={() => {
          painterRef.current.clear()
          setAutoDrawing(false)
          setCanUndo(painterRef.current.canUndo())
          setCanExportGif(painterRef.current.hasReplay())
        }}
        onDownload={() => {
          const href = painterRef.current.exportPng()
          if (!href) return
          const a = document.createElement('a')
          a.href = href
          a.download = '小画家模拟器.png'
          a.click()
        }}
        canExportGif={canExportGif && !autoDrawing}
        exportingGif={exportingGif}
        onExportGif={() => {
          if (exportingGif) return
          if (drawingRef.current) {
            drawingRef.current = false
            painterRef.current.endStroke()
            setCanUndo(painterRef.current.canUndo())
            setCanExportGif(painterRef.current.hasReplay())
          }
          setModal(null)
          setExportingGif(true)
          void buildReplayGif(painterRef.current)
            .then((blob) => {
              if (!blob) {
                setExportingGif(false)
                return
              }
              const url = URL.createObjectURL(blob)
              const next = { url, blob }
              gifPreviewRef.current = next
              setGifPreview(next)
            })
            .catch((err: unknown) => {
              setExportingGif(false)
              setError(err instanceof Error ? err.message : '导出失败')
            })
        }}
      />

      {error ? (
        <div className="rounded-xl border border-cinnabar/25 bg-cinnabar/8 px-3 py-2 text-sm text-cinnabar">
          {error}
        </div>
      ) : (
        <p className="text-xs text-muted">{hint}</p>
      )}

      <div className="flex flex-1 flex-col items-center">
        {phase !== 'draw' && (
          <section
            ref={frameRef}
            data-testid="reference-frame"
            className={cn(
              'relative mx-auto overflow-hidden rounded-2xl border bg-paper shadow-[0_18px_50px_-32px_rgba(28,25,22,0.55)]',
              dragOver ? 'border-cinnabar' : 'border-line/80',
            )}
            style={box}
          >
            {phase === 'lines' && (previewUrl || lineUrl) ? (
              <>
                {previewUrl && (
                  <img
                    src={previewUrl}
                    alt=""
                    data-testid="original-preview"
                    aria-hidden={showReference}
                    className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                  />
                )}
                {lineUrl && (
                  <img
                    src={lineUrl}
                    alt="参考图"
                    data-testid="line-preview"
                    aria-hidden={!showReference}
                    className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                    style={referenceFade}
                  />
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (!processing) fileRef.current?.click()
                }}
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[linear-gradient(180deg,#fffaf3,#f1eadc)] px-6 text-center"
              >
                <div className="rounded-full border border-dashed border-ink/20 px-3 py-1 text-[11px] text-muted">
                  PNG / JPG / WebP / SVG
                </div>
                <p className="text-sm font-medium text-ink">把图片拖到这里</p>
                <p className="text-xs text-muted">也可以点「使用示例图」</p>
              </button>
            )}
            {processing && !previewUrl && (
              <div
                data-testid="processing"
                className="absolute inset-0 grid place-items-center bg-paper/70 text-sm text-muted"
              >
                处理中…
              </div>
            )}
          </section>
        )}

        {phase === 'draw' && (
          <section className="flex w-full flex-col items-center gap-3">
            <div className="flex w-full max-w-3xl items-center justify-between gap-3 px-1">
              <h2 className="text-sm font-medium">临摹画布</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  data-testid="auto-draw"
                  disabled={!processed || processing || exportingGif || autoDrawing}
                  className="border-transparent bg-[#2f8f4e] text-white hover:bg-[#257a42]"
                  onClick={() => {
                    if (autoDrawing || exportingGif) return
                    setAutoDrawing(true)
                    const started = painterRef.current.startAutoDraw(() => {
                      setAutoDrawing(false)
                      setCanUndo(painterRef.current.canUndo())
                      setCanExportGif(painterRef.current.hasReplay())
                    })
                    if (!started) setAutoDrawing(false)
                  }}
                >
                  自动完成
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="show-original"
                  disabled={!originalUrl}
                  onClick={() => setModal('original')}
                >
                  展示原图
                </Button>
                <span ref={refBtnRef} className="inline-flex">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="show-reference"
                    disabled={!lineUrl}
                    onClick={() => setModal('lines')}
                  >
                    展示参考图
                  </Button>
                </span>
              </div>
            </div>
            <div
              className={cn(
                'relative mx-auto overflow-hidden rounded-2xl border border-line/80 bg-[#fffaf3] shadow-[0_18px_50px_-32px_rgba(28,25,22,0.55)]',
                (flyer || exportingGif || autoDrawing) && 'pointer-events-none',
              )}
              style={box}
            >
              <canvas
                ref={resultRef}
                data-testid="draw-canvas"
                className="absolute inset-0 h-full w-full touch-none cursor-none"
                style={{ touchAction: 'none' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onPointerLeave={(e) => {
                  updateCursor(e, false)
                  endPointer(e)
                }}
                onContextMenu={(e) => e.preventDefault()}
              />
              <canvas
                ref={rawRef}
                className={cn(
                  'pointer-events-none absolute inset-0 h-full w-full',
                  showRaw ? 'opacity-100' : 'opacity-0',
                )}
              />
              <div
                ref={cursorRef}
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cinnabar bg-cinnabar/40 opacity-0"
              />
            </div>
          </section>
        )}
      </div>

      {exportingGif && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4 backdrop-blur-[1px]"
          data-testid="export-mask"
          role={gifPreview ? 'dialog' : 'status'}
          aria-modal={gifPreview ? true : undefined}
          aria-label={gifPreview ? '导出的 GIF' : undefined}
          aria-live={gifPreview ? undefined : 'polite'}
          onClick={() => {
            if (gifPreview) closeGifPreview()
          }}
        >
          {gifPreview ? (
            <div
              className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_24px_80px_-28px_rgba(28,25,22,0.7)]"
              data-testid="gif-preview"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="grid min-h-0 flex-1 place-items-center bg-[linear-gradient(180deg,#fffaf3,#f3eee4)] p-4">
                <img
                  src={gifPreview.url}
                  alt=""
                  className="max-h-[70vh] max-w-full object-contain"
                />
              </div>
              <div className="flex items-center justify-center gap-2 border-t border-line/70 px-4 py-3">
                <Button data-testid="gif-save" onClick={saveGif}>
                  保存
                </Button>
                {isMobileDevice() && (
                  <Button variant="outline" data-testid="gif-share" onClick={() => void shareGif()}>
                    分享
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="rounded-full border border-line/80 bg-paper px-4 py-2 text-sm text-ink shadow-[0_18px_50px_-28px_rgba(28,25,22,0.55)]">
              正在导出
            </p>
          )}
        </div>
      )}

      {flyer && flyerStyle && lineUrl && (
        <img
          src={lineUrl}
          alt=""
          data-testid="line-flyer"
          className="pointer-events-none fixed z-30 rounded-2xl bg-paper object-contain shadow-[0_18px_50px_-28px_rgba(28,25,22,0.55)]"
          style={flyerStyle}
          onTransitionEnd={(event) => {
            if (event.propertyName !== 'transform') return
            setFlyer((current) => (current?.run ? { ...current, fading: true } : current))
          }}
        />
      )}

      {modal === 'original' && originalUrl && (
        <ImageModal title="原图" src={originalUrl} onClose={closeModal} />
      )}
      {modal === 'lines' && lineUrl && (
        <ImageModal title="参考图" src={lineUrl} onClose={closeModal} />
      )}

      <footer className="pb-2 text-center text-[11px] text-muted">
        全部在浏览器本地完成，图片不会上传到服务器。
      </footer>
    </div>
  )
}

export default App
