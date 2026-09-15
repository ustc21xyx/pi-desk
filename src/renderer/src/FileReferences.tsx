import { useEffect, useState, type RefObject } from 'react'
import { FileCode2 } from 'lucide-react'
export function ReferencedText({ text, onFile }: { text: string; onFile: (path: string) => void }) {
  const parts: React.ReactNode[] = []; let end = 0, count = 0
  for (const match of text.matchAll(/(?:^|(?<=\s))@(?:"([^"\n]+)"|([^\s<>]+))/g)) {
    if (++count > 100) break
    const path = (match[1] || match[2]).replace(/[，。；：！？、）]+$/, '')
    if (!path || /^https?:/.test(path)) continue
    const index = match.index!
    parts.push(text.slice(end, index), <button key={index} className="file-reference" title={path} onClick={() => onFile(path)}><FileCode2 size={12} />{path.split('/').at(-1)}</button>)
    end = index + match[0].length
    if (!match[1]) parts.push(match[2].slice(path.length))
  }
  parts.push(text.slice(end)); return <>{parts}</>
}
export function FileReferenceInput({ cwd, value, onChange, inputRef, onSend }: { cwd: string; value: string; onChange: (value: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>; onSend: () => void }) {
  const [caret, setCaret] = useState(0), [paths, setPaths] = useState<string[]>([]), [selected, setSelected] = useState(0), [loading, setLoading] = useState(false), [note, setNote] = useState(''), [dismissed, setDismissed] = useState('')
  const [composing, setComposing] = useState(false)
  const match = value.slice(0, caret).match(/(?:^|\s)@(?:"([^"\n]{0,200})|([^\s@"\n]{0,200}))$/)
  const query = match ? match[1] ?? match[2] : undefined, token = `${caret}:${value}`
  const open = !!cwd && query !== undefined && dismissed !== token && !composing
  useEffect(() => {
    setPaths([]); setSelected(0); setNote('')
    if (!open) { setLoading(false); return }
    let current = true; setLoading(true)
    const timer = setTimeout(() => { void window.desk.fileReferences(cwd, query || '').then(result => { if (current) { setPaths(result.paths); setNote(result.truncated ? '仅显示部分结果，继续输入可缩小范围' : result.paths.length ? '' : '没有匹配文件') } }).catch(() => { if (current) setNote('文件列表暂时不可用') }).finally(() => { if (current) setLoading(false) }) }, 140)
    return () => { current = false; clearTimeout(timer) }
  }, [open, cwd, query])
  function choose(path: string) {
    const start = caret - (query?.length || 0) - (match?.[1] !== undefined ? 2 : 1), reference = `@${/\s/.test(path) ? `"${path}"` : path} `
    onChange(value.slice(0, start) + reference + value.slice(caret)); setDismissed(`${caret}:${value}`)
    requestAnimationFrame(() => { const el = inputRef.current; el?.focus(); el?.setSelectionRange(start + reference.length, start + reference.length); setCaret(start + reference.length) })
  }
  return <><textarea ref={inputRef} value={value} rows={2} placeholder={cwd ? '描述你的想法，@ 引用文件，/ 查看命令…' : '描述你的想法，发送时选择项目…'} aria-label="发送给 Pi 的消息" aria-expanded={open} aria-controls={open ? 'file-reference-options' : undefined} aria-activedescendant={open && paths[selected] ? `file-reference-${selected}` : undefined}
    onCompositionStart={() => setComposing(true)} onCompositionEnd={e => { setComposing(false); setCaret(e.currentTarget.selectionStart) }} onSelect={e => setCaret(e.currentTarget.selectionStart)} onChange={e => { onChange(e.target.value); setCaret(e.target.selectionStart); setDismissed('') }}
    onKeyDown={e => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      if (open && e.key === 'Escape') { e.preventDefault(); setDismissed(token); return }
      if (open && paths.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setSelected(i => (i + (e.key === 'ArrowDown' ? 1 : paths.length - 1)) % paths.length); return }
      if (open && paths[selected] && (e.key === 'Tab' || e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); choose(paths[selected]); return }
      if (open && (loading || !paths.length) && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setDismissed(token); return }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
    }} />
    {open && <div className="file-reference-menu" id="file-reference-options" role="listbox" aria-label="项目文件">{paths.map((path, i) => <button key={path} id={`file-reference-${i}`} role="option" aria-selected={i === selected} className={i === selected ? 'selected' : ''} onMouseDown={e => e.preventDefault()} onClick={() => choose(path)}><FileCode2 size={13} /><span>{path.split('/').at(-1)}<small>{path}</small></span></button>)}{(loading || note) && <p>{loading ? '正在查找文件…' : note}</p>}</div>}
  </>
}
