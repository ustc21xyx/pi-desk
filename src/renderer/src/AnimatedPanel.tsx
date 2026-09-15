import { useLayoutEffect, useState, type ReactNode } from 'react'

// Keep the current view mounted until its closing transition has finished.
export function AnimatedPanel({ children }: { children: ReactNode }) {
  const open = Boolean(children)
  const [retained, setRetained] = useState<ReactNode>(null)
  useLayoutEffect(() => {
    if (children) { setRetained(children); return }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setRetained(null); return }
    // Also release the view if a hidden window does not dispatch transitionend.
    const timer = window.setTimeout(() => setRetained(null), 250)
    return () => window.clearTimeout(timer)
  }, [children])
  return <div className={`right-panel-slot ${open ? 'open' : ''}`} inert={!open} aria-hidden={!open}
    onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === 'opacity' && !open) setRetained(null) }}>
    {children || retained}
  </div>
}
