import { useState } from 'react'
import { ChevronDown, Copy, X } from 'lucide-react'
import type { RecoveryPreview, RuntimeSnapshot } from '../../shared/contracts'
import { clean, RichText } from './components'
export function QueuePreview({ runtime, clear, error }: { runtime: RuntimeSnapshot; clear: () => Promise<void>; error: (e: unknown) => void }) {
  const [confirm, setConfirm] = useState(false), [clearing, setClearing] = useState(false)
  const count = runtime.queue.steering.length + runtime.queue.followUp.length
  if (!count) return null
  return <details className="queue-preview"><summary>{count} 条消息等待处理<ChevronDown size={12} /></summary><div className="queue-items">
    {(['steering', 'followUp'] as const).map(kind => runtime.queue[kind].length > 0 && <section key={kind}><strong>{kind === 'steering' ? '插话 · 在 Pi 可接收时处理' : '完成后发送'}</strong>{runtime.queue[kind].map((text, i) => <div className="queued-message" key={`${kind}:${i}`}><p>{clean(text)}</p><button className="icon-button" title="复制待处理消息" onClick={() => void window.desk.copyText(text).catch(error)}><Copy size={12} /></button></div>)}</section>)}
  </div><footer>{confirm ? <><span>清空所有尚未处理的消息？</span><button className="text-button" disabled={clearing} onClick={() => { setClearing(true); void clear().catch(error).finally(() => { setClearing(false); setConfirm(false) }) }}>确认清空</button><button className="text-button" onClick={() => setConfirm(false)}>取消</button></> : <><span>本机 Pi 队列 · 暂不支持逐条撤回</span><button className="text-button" onClick={() => setConfirm(true)}>清空全部</button></>}</footer></details>
}
export function RecoveredReply({ value, dismiss, error }: { value: RecoveryPreview; dismiss: () => Promise<void>; error: (e: unknown) => void }) {
  const [open, setOpen] = useState(false)
  return <details className="recovered-reply" onToggle={e => setOpen(e.currentTarget.open)}><summary>上次中断时的回复 · 仅供查看<ChevronDown size={12} /></summary>{open && <><p className="recovery-hint">保存于 {new Date(value.savedAt).toLocaleString()}。可能不完整，未加入 Pi 上下文，也不会自动重发。{value.truncated && '内容较长，仅保存部分文本。'}</p><div className="recovered-content">{value.message.blocks.map((block, i) => block.type === 'thinking' ? <details className="thinking" key={i}><summary>思考过程</summary><pre>{clean(block.text || '')}</pre></details> : <div className="markdown" key={i}><RichText text={clean(block.text || '')} /></div>)}</div><footer><button className="text-button" onClick={() => void window.desk.copyText(value.message.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')).catch(error)}><Copy size={12} />复制回复</button><button className="text-button" onClick={() => void dismiss().catch(error)}><X size={12} />移除此恢复预览</button></footer></>}</details>
}
