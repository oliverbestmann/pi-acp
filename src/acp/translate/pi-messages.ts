export function normalizePiMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

export function normalizePiAssistantText(content: unknown): string {
  // Assistant content is typically an array of blocks; only replay text blocks for MVP.
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

/**
 * Render a displayed pi custom message (e.g. extension check results) as a finished ACP tool call.
 * Extensions may set `details.title` and `details.isError`.
 */
export function customMessageToolCall(m: any) {
  if (m?.role !== 'custom' || !m.display) return undefined
  const text = normalizePiMessageText(m.content)
  return {
    sessionUpdate: 'tool_call' as const,
    toolCallId: `custom-${m.customType}-${m.timestamp ?? Date.now()}`,
    title: String(m.details?.title ?? m.customType ?? 'extension'),
    kind: 'other' as const,
    status: m.details?.isError ? ('failed' as const) : ('completed' as const),
    content: text ? [{ type: 'content' as const, content: { type: 'text' as const, text } }] : undefined
  }
}
