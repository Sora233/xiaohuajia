import { useEffect } from 'react'

type ImageModalProps = {
  title: string
  src: string
  onClose: () => void
}

/** 居中看一张图。点空白或按 Esc 关掉。 */
export function ImageModal({ title, src, onClose }: ImageModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_24px_80px_-28px_rgba(28,25,22,0.7)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line/70 px-4 py-2.5">
          <h2 className="text-sm font-medium">{title}</h2>
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-paper-2 hover:text-ink"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <div className="grid min-h-0 flex-1 place-items-center bg-[linear-gradient(180deg,#fffaf3,#f3eee4)] p-4">
          <img src={src} alt={title} className="max-h-[80vh] max-w-full object-contain" />
        </div>
      </div>
    </div>
  )
}
