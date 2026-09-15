import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { nameOf } from './components'

export function ProjectPicker({ value, projects, disabled, onChange, onBrowse }: {
  value: string; projects: string[]; disabled: boolean; onChange: (path: string) => void; onBrowse: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  // Keep the current project available even while the project index refreshes.
  const paths = [...new Set([value, ...projects].filter(Boolean))]
  const choices = ['', ...paths]
  const expanded = open && !disabled
  function close(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger.current?.focus() }
  function items() { return Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') || []) }
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (!expanded) return
    const selected = root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    selected?.focus({ preventScroll: true })
    if (selected?.parentElement) selected.parentElement.scrollTop = Math.max(0, selected.offsetTop - selected.parentElement.clientHeight / 2)
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [expanded])
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') {
      // Return to the trigger before the browser advances to the adjacent control.
      trigger.current?.focus(); setOpen(false); return
    }
    const buttons = items(), current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length
    else if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1
    else return
    event.preventDefault(); buttons[next]?.focus()
  }
  return <div className="project-picker" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className="project-picker-trigger" disabled={disabled} title={value || '选择项目'} aria-label={`项目：${value ? nameOf(value) : '未选择'}`} aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined}
      onClick={() => setOpen(!expanded)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
      }}><Folder size={14} /><span>{value ? nameOf(value) : '选择项目'}</span><ChevronDown size={12} /></button>
    {expanded && <div id={menuId} role="menu" aria-label="选择项目" className="project-picker-menu" onKeyDown={navigate}>
      <div className="project-picker-list" role="group" aria-label="已有项目">
        {choices.map(path => <button key={path} type="button" role="menuitemradio" aria-checked={value === path} tabIndex={-1} title={path || '选择项目'} onClick={() => { close(true); onChange(path) }}>
          <Folder size={14} /><span>{path ? nameOf(path) : '选择项目'}{path && <small>{path}</small>}</span><Check size={13} className={value === path ? '' : 'project-check-hidden'} />
        </button>)}
      </div>
      <button type="button" role="menuitem" tabIndex={-1} className="project-picker-browse" onClick={() => { close(true); onBrowse() }}><FolderOpen size={14} /><span>打开文件夹…</span></button>
    </div>}
  </div>
}
