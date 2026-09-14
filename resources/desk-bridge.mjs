/** Pi Desk-only compatibility. Uses standard extension UI; no global config changes. */
export default function deskBridge(pi) {
  pi.registerCommand('desk-edit-message', {
    description: 'Pi Desk：回到最近的用户消息',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'rpc' || process.env.PI_DESK !== '1' || !ctx.isIdle()) return
      const entry = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === 'message' && e.message.role === 'user')
      if (!entry || entry.id !== args.trim()) return
      await ctx.navigateTree(entry.id, { summarize: false })
    }
  })
  pi.on('tool_result', async (event, ctx) => {
    if (ctx.mode !== 'rpc' || process.env.PI_DESK !== '1' || event.toolName !== 'question') return
    const unavailable = event.content?.some(block => block.type === 'text' && block.text?.includes('非交互模式下无法提问'))
    if (!unavailable || typeof event.input?.question !== 'string' || !Array.isArray(event.input.options)) return
    // Repair only this known terminal-only result, before Pi persists or submits it to the model.
    const options = event.input.options.map((o, i) => `${i + 1}. ${String(o.label)}${o.description ? ' — ' + String(o.description) : ''}`)
    const custom = '输入其他答案…'
    const selected = await ctx.ui.select(event.input.question, [...options, custom], { signal: ctx.signal })
    if (ctx.signal?.aborted || selected === undefined) return { content: [{ type: 'text', text: '用户取消了回答。' }], details: { ...event.details, answer: null }, isError: false }
    const answer = selected === custom ? await ctx.ui.input(event.input.question, '输入你的回答', { signal: ctx.signal }) : event.input.options[options.indexOf(selected)]?.label
    return { content: [{ type: 'text', text: answer ? `用户回答：${answer}` : '用户取消了回答。' }], details: { ...event.details, answer: answer || null, wasCustom: selected === custom }, isError: false }
  })
}
