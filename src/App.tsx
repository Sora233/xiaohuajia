import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { Toolbar } from '@/components/Toolbar'
import {
  loadHtmlImage,
  processSource,
  type ProcessedImage,
} from '@/lib/image-process'
import { SAMPLE_IMAGE_SRC } from '@/lib/sample'
import { pointerToCanvas, StrokePainter } from '@/lib/stroke-painter'
import { cn } from '@/lib/utils'

function App() {
  const fileRef = useRef<HTMLInputElement>(null)
  const resultRef = useRef<HTMLCanvasElement>(null)
  const rawRef = useRef<HTMLCanvasElement>(null)
  const refCanvasRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const painterRef = useRef(new StrokePainter())
  const objectUrlRef = useRef<string | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const drawingRef = useRef(false)

  const [processed, setProcessed] = useState<ProcessedImage | null>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [brushSize, setBrushSize] = useState(36)
  const [detail, setDetail] = useState(62)
  const [colorMode, setColorMode] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [hint, setHint] = useState('先放一张参考图，再顺着线条的大致方向画')
  const brushRef = useRef(brushSize)
  const colorRef = useRef(colorMode)

  const syncRefCanvas = useCallback((image: ProcessedImage) => {
    const canvas = refCanvasRef.current
    if (!canvas) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(image.color, 0, 0)
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
    painter.setSnapRadius(brushRef.current)
    painter.setDocument({
      contours: image.contours,
      index: image.index,
      color: image.color,
    })
    painter.setColorMode(colorRef.current)
    setCanUndo(painter.canUndo())
  }, [])

  const ingestImage = useCallback(
    async (img: HTMLImageElement, nextDetail: number, resetDrawing: boolean) => {
      setProcessing(true)
      setError(null)
      setHint('正在提取轮廓…')
      try {
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const next = await processSource(img, nextDetail)
        imageRef.current = img
        setProcessed(next)
        bindPainter(next, resetDrawing)
        syncRefCanvas(next)
        const lens = next.contours
          .map((c) => c.points.length)
          .sort((a, b) => b - a)
          .slice(0, 8)
        console.debug('[小画家模拟器] 轮廓', next.contours.length, '最长', lens)
        setHint(
          next.contours.length
            ? `已提取 ${next.contours.length} 条轮廓。顺着线画，乱笔会吸附上去`
            : '几乎没提取到轮廓，试试提高「线条细节」',
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : '处理失败')
        setHint('换一张图片再试试')
      } finally {
        setProcessing(false)
      }
    },
    [bindPainter, syncRefCanvas],
  )

  const loadFromSrc = useCallback(
    async (src: string, resetDrawing: boolean) => {
      try {
        const img = await loadHtmlImage(src)
        await ingestImage(img, detail, resetDrawing)
      } catch (err) {
        setError(err instanceof Error ? err.message : '无法读取这张图片')
        setHint('换一张图片再试试')
      }
    },
    [detail, ingestImage],
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
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  useEffect(() => {
    colorRef.current = colorMode
    painterRef.current.setColorMode(colorMode)
  }, [colorMode])

  useEffect(() => {
    brushRef.current = brushSize
    painterRef.current.setSnapRadius(brushSize)
  }, [brushSize])

  useEffect(() => {
    const img = imageRef.current
    if (!img) return
    const handle = window.setTimeout(() => {
      void ingestImage(img, detail, false)
    }, 160)
    return () => window.clearTimeout(handle)
  }, [detail, ingestImage])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (painterRef.current.undo()) setCanUndo(painterRef.current.canUndo())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const updateCursor = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>, visible: boolean) => {
      const el = cursorRef.current
      const canvas = resultRef.current
      if (!el || !canvas) return
      const rect = canvas.getBoundingClientRect()
      const scale = rect.width / canvas.width
      const r = brushSize * scale
      el.style.width = `${r * 2}px`
      el.style.height = `${r * 2}px`
      el.style.left = `${event.clientX - rect.left}px`
      el.style.top = `${event.clientY - rect.top}px`
      el.style.opacity = visible ? '1' : '0'
    },
    [brushSize],
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!processed || processing) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    const { x, y } = pointerToCanvas(event, event.currentTarget)
    painterRef.current.setSnapRadius(brushSize)
    painterRef.current.beginStroke(x, y)
    updateCursor(event, true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
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

  const aspect = processed
    ? `${processed.width} / ${processed.height}`
    : '5 / 4'

  return (
    <div className="mx-auto flex min-h-svh max-w-6xl flex-col gap-5 px-4 py-6 md:gap-6 md:px-6 md:py-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium tracking-[0.22em] text-cinnabar">
            临摹练习
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            《小画家模拟器》
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            左边是参考，右边顺着轮廓的方向乱画。每一笔都会被掰到最近的参考轮廓上——画得再晃，落纸的也是那条真线。
          </p>
        </div>
        <p className="max-w-xs text-xs leading-relaxed text-muted sm:text-right">
          空白处超过吸附距离就不会落墨。把所有轮廓描一遍，就能复原整张线稿。
        </p>
      </header>

      <Toolbar
        fileRef={fileRef}
        hasImage={Boolean(processed)}
        canUndo={canUndo}
        processing={processing}
        brushSize={brushSize}
        detail={detail}
        colorMode={colorMode}
        showRaw={showRaw}
        onUploadClick={() => fileRef.current?.click()}
        onFileChange={onFileChange}
        onSample={() => {
          void loadFromSrc(SAMPLE_IMAGE_SRC, true)
        }}
        onBrushSize={setBrushSize}
        onDetail={setDetail}
        onColorMode={setColorMode}
        onShowRaw={setShowRaw}
        onUndo={() => {
          painterRef.current.undo()
          setCanUndo(painterRef.current.canUndo())
        }}
        onClear={() => {
          painterRef.current.clear()
          setCanUndo(painterRef.current.canUndo())
        }}
        onDownload={() => {
          const href = painterRef.current.exportPng()
          if (!href) return
          const a = document.createElement('a')
          a.href = href
          a.download = '小画家模拟器.png'
          a.click()
        }}
      />

      {error ? (
        <div className="rounded-xl border border-cinnabar/25 bg-cinnabar/8 px-3 py-2 text-sm text-cinnabar">
          {error}
        </div>
      ) : (
        <p className="text-xs text-muted">{hint}</p>
      )}

      <div
        className="grid flex-1 items-start gap-4 lg:grid-cols-2"
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <section
          className={cn(
            'overflow-hidden rounded-2xl border bg-paper shadow-[0_18px_50px_-32px_rgba(28,25,22,0.55)] transition-colors',
            dragOver ? 'border-cinnabar' : 'border-line/80',
          )}
        >
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-2.5">
            <h2 className="text-sm font-medium">参考图</h2>
            <span className="text-[11px] text-muted">拖放或点击更换</span>
          </div>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="relative block w-full text-left"
            style={{ aspectRatio: aspect }}
          >
            <canvas
              ref={refCanvasRef}
              data-testid="reference-canvas"
              className={cn(
                'absolute inset-0 h-full w-full',
                processed ? 'block' : 'hidden',
              )}
            />
            {!processed && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[linear-gradient(180deg,#fffaf3,#f1eadc)] px-6 text-center">
                <div className="rounded-full border border-dashed border-ink/20 px-3 py-1 text-[11px] text-muted">
                  PNG / JPG / WebP / SVG
                </div>
                <p className="text-sm font-medium text-ink">把图片拖到这里</p>
                <p className="text-xs text-muted">
                  也可以点「使用示例图」，先感受吸附效果
                </p>
              </div>
            )}
            {processing && (
              <div className="absolute inset-0 grid place-items-center bg-paper/70 text-sm text-muted">
                正在提取轮廓…
              </div>
            )}
          </button>
        </section>

        <section className="overflow-hidden rounded-2xl border border-line/80 bg-paper shadow-[0_18px_50px_-32px_rgba(28,25,22,0.55)]">
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-2.5">
            <h2 className="text-sm font-medium">临摹画布</h2>
            <span className="text-[11px] text-muted">笔画吸附到参考轮廓</span>
          </div>
          <div className="relative w-full bg-[#fffaf3]" style={{ aspectRatio: aspect }}>
            {!processed && (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted">
                上传参考后，在线条附近画一条晃晃的线试试
              </div>
            )}
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
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-cinnabar/70 bg-cinnabar/10 opacity-0"
            />
          </div>
        </section>
      </div>

      <footer className="pb-2 text-center text-[11px] text-muted">
        全部在浏览器本地完成，图片不会上传到服务器。
      </footer>
    </div>
  )
}

export default App
