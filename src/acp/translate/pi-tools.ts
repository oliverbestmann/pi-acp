const MAX_TOOL_TITLE_LENGTH = 160
const TITLE_ARG_KEYS = [
  'path',
  'file_path',
  'pattern',
  'glob',
  'query',
  'url',
  'target',
  'action',
  'name',
  'id'
] as const

function titleValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text || undefined
}

function truncateTitle(title: string): string {
  return title.length <= MAX_TOOL_TITLE_LENGTH ? title : `${title.slice(0, MAX_TOOL_TITLE_LENGTH - 1)}…`
}

export function toolTitle(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolName

  const input = args as Record<string, unknown>
  const pattern = titleValue(input.pattern)
  if (toolName === 'grep' && pattern) {
    const scope = titleValue(input.path) ?? titleValue(input.glob)
    return truncateTitle(`${toolName} ${JSON.stringify(pattern)}${scope ? ` in ${scope}` : ''}`)
  }

  const action = titleValue(input.action)
  const query = titleValue(input.query)
  if (action && query) return truncateTitle(`${toolName} ${action} ${JSON.stringify(query)}`)

  for (const key of TITLE_ARG_KEYS) {
    const value = titleValue(input[key])
    if (value) return truncateTitle(`${toolName} ${value}`)
  }

  return toolName
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
