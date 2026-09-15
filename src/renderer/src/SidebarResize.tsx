import { useEffect, useRef, useState, type CSSProperties } from 'react'

type Widths = { left?: number; right?: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function useSidebarWidths(sidebar: boolean, panel: boolean) {
  const [viewport, setViewport] = useState(window.innerWidth)
  const [dragging, setDragging] = useState(false)
  const [widths, setWidths] = useState<Widths>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('pi-desk-sidebar-widths') || '{}')
      return { left: typeof saved?.left === 'number' && Number.isFinite(saved.left) ? clamp(saved.left, 200, 440) : undefined,
        right: typeof saved?.right === 'number' && Number.isFinite(saved.right) ? clamp(saved.right, 300, 900) : undefined }
    } catch { return {} }
  })
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => { try { localStorage.setItem('pi-desk-sidebar-widths', JSON.stringify(widths)) } catch {} }, 200)
    return () => window.clearTimeout(timer)
  }, [widths])
  const leftVisible = sidebar && !(panel && viewport <= 1100)
  const desiredLeft = widths.left ?? (viewport <= 1100 ? 225 : panel ? 244 : 258)
  // Reserve enough room for the composer, even when both sidebars are expanded.
  const left = clamp(desiredLeft, 200, Math.min(440, viewport - 420 - (panel ? 300 : 0)))
  const rightMax = Math.max(300, Math.min(900, viewport - 420 - (leftVisible ? left : 0)))
  const right = clamp(widths.right ?? viewport * (viewport <= 1100 ? .4 : sidebar ? .36 : .38), 300, rightMax)
  const leftMax = Math.max(200, Math.min(440, viewport - 420 - (panel ? right : 0)))
  const change = (side: keyof Widths, value?: number) => setWidths(previous => ({ ...previous, [side]: value }))
  const style = { '--sidebar-width': `${left}px`, '--panel-width': `${right}px` } as CSSProperties
  return { style, dragging, setDragging, leftVisible, left, right, leftMax, rightMax, change }
}

export function SidebarResize({ side, width, min, max, onChange, onDragging }: {
  side: 'left' | 'right'; width: number; min: number; max: number;
  onChange: (value?: number) => void; onDragging: (value: boolean) => void
}) {
  const drag = useRef<{ x: number; width: number; pointer: number } | undefined>(undefined)
  const direction = side === 'left' ? 1 : -1
  useEffect(() => {
    const stop = () => { drag.current = undefined; onDragging(false) }
    window.addEventListener('blur', stop)
    return () => { window.removeEventListener('blur', stop); stop() }
  }, [onDragging])
  const stop = () => { drag.current = undefined; onDragging(false) }
  return <div className={`sidebar-resize sidebar-resize-${side}`} role="separator" tabIndex={0}
    aria-label={side === 'left' ? '调整左侧栏宽度' : '调整右侧栏宽度'} aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(width)}
    title="拖动调整宽度，双击恢复默认；方向键微调"
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.clientX, width, pointer: event.pointerId }; onDragging(true)
    }}
    onPointerMove={event => {
      const start = drag.current
      if (start && start.pointer === event.pointerId) onChange(clamp(start.width + (event.clientX - start.x) * direction, min, max))
    }}
    onPointerUp={event => { stop(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={stop} onLostPointerCapture={stop} onDoubleClick={() => onChange(undefined)}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      onChange(event.key === 'Home' ? min : event.key === 'End' ? max : clamp(width + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 10), min, max))
    }} />
}
