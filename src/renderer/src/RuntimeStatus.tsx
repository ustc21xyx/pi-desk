import { useEffect, useState } from 'react'
import type { RuntimeSnapshot } from '../../shared/contracts'
const elapsed = (ms: number) => ms < 60000 ? `${Math.floor(ms / 1000)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`
export function RuntimeStatus({ runtime }: { runtime: RuntimeSnapshot }) {
  const [now, setNow] = useState(Date.now())
  const active = !['idle', 'error', 'closed'].includes(runtime.phase)
  useEffect(() => { if (!active) return; const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000); return () => clearInterval(timer) }, [active])
  const tools = Object.values(runtime.tools).filter(t => t.status === 'running')
  const reply = runtime.messages.findLast(m => m.role === 'assistant')
  const phase = runtime.phase
  const label = phase === 'starting' ? '正在连接 Pi' : phase === 'waiting' ? '等待你的回答' : phase === 'retrying' ? `正在重试${runtime.retry?.attempt ? ` · ${runtime.retry.attempt}${runtime.retry.max ? `/${runtime.retry.max}` : ''}` : ''}` : phase === 'compacting' ? '正在整理上下文' : phase === 'closed' ? 'Pi 已断开' : phase === 'error' ? 'Pi 连接异常' : phase === 'idle' ? runtime.outcome === 'error' ? '本轮未完成' : '已就绪' : tools.length ? `正在执行 ${tools[0].name}${tools.length > 1 ? ` 等 ${tools.length} 个工具` : ''}` : reply?.streaming && reply.blocks.some(b => b.type === 'text' && b.text) ? '正在生成回复' : reply?.streaming && reply.blocks.some(b => b.type === 'thinking' && b.text) ? '正在思考' : '等待模型响应'
  const idleFor = Math.max(0, now - (runtime.lastEventAt || runtime.phaseStartedAt || now))
  return <details className="runtime-status"><summary>{label}</summary><div className="runtime-status-detail">
    <strong>{label}</strong>
    {active && <p>当前阶段已用 {elapsed(Math.max(0, now - (runtime.phaseStartedAt || now)))}</p>}
    {runtime.lastEventAt && active && <p>最近收到 Pi 事件：{elapsed(idleFor)}前</p>}
    {runtime.retry?.reason && <p>{runtime.retry.reason}</p>}
    {runtime.retry?.until && runtime.retry.until > now && <p>约 {Math.ceil((runtime.retry.until - now) / 1000)} 秒后再次尝试</p>}
    {active && idleFor >= 45000 && <p>较长时间没有新事件，可能仍在等待模型或工具。可以继续等待或手动停止。</p>}
    {['error', 'closed'].includes(phase) && <p>已显示的回复仍保留。发送前会重新连接；没有自动重发消息。</p>}
    {phase === 'retrying' && <p>重试由本机 Pi 管理，可用停止按钮取消。</p>}
  </div></details>
}
