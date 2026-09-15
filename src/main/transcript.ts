import type { DisplayBlock, DisplayMessage, EditDiff, JsonObject, ModelInfo } from '../shared/contracts'

// Preserve only Pi's actual edit result, not the entire extension details object.
export function editDiff(result: JsonObject | undefined): EditDiff | undefined {
  if (!result || result.isError) return undefined
  const details = result.details
  const patch = typeof details?.patch === 'string' && details.patch.length > 0 ? details.patch : undefined
  const text = patch || (typeof details?.diff === 'string' ? details.diff : '')
  if (!text) return undefined
  const prefix = text.slice(0, 150_000), lines = prefix.split('\n')
  return { text: lines.slice(0, 1500).join('\n'), format: patch ? 'unified' : 'pi', truncated: text.length > prefix.length || lines.length > 1500 }
}

export const clipped = (value: unknown, limit = 150_000): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)
  return text.length > limit ? `${text.slice(0, limit)}\n…（显示已截断，Pi 原记录完整保留）` : text
}
export function displayBlock(b: JsonObject): DisplayBlock | null {
  if (b?.type === 'text') return { type: 'text', text: clipped(b.text) }
  if (b?.type === 'thinking') return { type: 'thinking', text: clipped(b.thinking) }
  if (b?.type === 'image' && /^image\/(png|jpeg|webp|gif)$/.test(b.mimeType) && typeof b.data === 'string' && b.data.length < 16_000_000) return { type: 'image', data: b.data, mimeType: b.mimeType }
  if (b?.type === 'toolCall') return { type: 'toolCall', id: String(b.id), name: String(b.name), arguments: clipped(b.arguments) }
  return null
}
export function displayMessage(m: JsonObject, id: string): DisplayMessage {
  const content = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: m?.content || m?.output || '' }]
  return { id, timestamp: typeof m?.timestamp === 'number' ? m.timestamp : undefined, stopReason: m?.stopReason, role: String(m?.role || 'custom'), blocks: content.map(displayBlock).filter((b): b is DisplayBlock => b !== null), toolCallId: m?.toolCallId, toolName: m?.toolName, isError: m?.isError, editDiff: m?.role === 'toolResult' && m?.toolName === 'edit' ? editDiff(m) : undefined, error: m?.errorMessage ? clipped(m.errorMessage, 3000) : undefined }
}
export function modelInfo(m: JsonObject | undefined): ModelInfo | undefined {
  if (!m || typeof m.id !== 'string' || typeof m.provider !== 'string') return undefined
  const thinkingLevelMap: ModelInfo['thinkingLevelMap'] = m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object' && !Array.isArray(m.thinkingLevelMap)
    ? Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].flatMap(level => {
      const mapped = m.thinkingLevelMap[level]
      return mapped === null || (typeof mapped === 'string' && mapped.length <= 100) ? [[level, mapped]] : []
    })) : undefined
  // Never forward provider headers or auth fields to the renderer.
  return { id: m.id, provider: m.provider, name: String(m.name || m.id), reasoning: Boolean(m.reasoning), input: Array.isArray(m.input) ? m.input.filter((x: unknown) => typeof x === 'string') : [], contextWindow: Number(m.contextWindow || 0), thinkingLevelMap }
}
const modelCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
export function compareModels(a: ModelInfo, b: ModelInfo): number {
  return modelCollator.compare(a.id, b.id) || modelCollator.compare(a.provider, b.provider) || modelCollator.compare(a.name, b.name)
}
export function activeBranch(entries: JsonObject[], leaf?: string | null): JsonObject[] {
  if (leaf === null) return []
  const valid = entries.filter(e => e.type !== 'session')
  if (!valid.some(e => e.id && 'parentId' in e)) return valid
  const byId = new Map(valid.map(e => [e.id, e])), seen = new Set<string>(), branch: JsonObject[] = []
  let entry = leaf ? byId.get(leaf) : valid.at(-1)
  while (entry && !seen.has(entry.id)) { seen.add(entry.id); branch.push(entry); entry = entry.parentId ? byId.get(entry.parentId) : undefined }
  return branch.reverse()
}
