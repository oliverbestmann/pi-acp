const MAX_TOOL_TITLE_LENGTH = 160
// Tool output is shown as a plain (non-collapsible) content block in ACP clients, so cap it
// to keep huge command/file output from flooding the chat. Keep head and tail so both the
// start of a long listing and a trailing error/summary stay visible.
const MAX_TOOL_OUTPUT_LENGTH = 20_000
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

function truncateToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_LENGTH) return text

  const headLength = Math.floor(MAX_TOOL_OUTPUT_LENGTH * 0.7)
  const tailLength = MAX_TOOL_OUTPUT_LENGTH - headLength
  const omitted = text.length - headLength - tailLength
  const head = text.slice(0, headLength)
  const tail = text.slice(text.length - tailLength)

  return `${head}\n\n...(truncated ${omitted} characters)...\n\n${tail}`
}

// Tools that ask the user to pick from a list of options (optionally with a free-text
// "other" answer). Their JSON args render unreadably as a raw-JSON fallback in ACP clients
// (each long option description becomes one unwrapped line), so we give them a proper
// wrapped text content block instead.
const QUESTION_TOOL_NAMES = new Set(['ask_user_question', 'questionnaire'])

export function toolInputContent(toolName: string, args: unknown): { type: 'content'; content: { type: 'text'; text: string } }[] | undefined {
  if (!QUESTION_TOOL_NAMES.has(toolName)) return undefined
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined

  const questions = (args as Record<string, unknown>).questions
  if (!Array.isArray(questions) || !questions.length) return undefined

  const lines: string[] = []
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue
    const question = q as Record<string, unknown>

    const text = titleValue(question.question) ?? titleValue(question.prompt)
    if (text) {
      if (lines.length) lines.push('')
      lines.push(text)
    }

    const options = question.options
    if (!Array.isArray(options)) continue

    options.forEach((opt, i) => {
      if (!opt || typeof opt !== 'object') return
      const option = opt as Record<string, unknown>
      const label = titleValue(option.label) ?? titleValue(option.value)
      if (!label) return
      const description = titleValue(option.description)
      lines.push(`${i + 1}. ${label}${description ? ` — ${description}` : ''}`)
    })
  }

  if (!lines.length) return undefined
  return [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }]
}

export function toolTitle(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolName

  const input = args as Record<string, unknown>
  const pattern = titleValue(input.pattern)
  if (toolName === 'grep' && pattern) {
    const scope = titleValue(input.path) ?? titleValue(input.glob)
    return truncateTitle(`${toolName} ${JSON.stringify(pattern)}${scope ? ` in ${scope}` : ''}`)
  }

  // MCP gateway calls wrap the real tool: { tool: "jflow_commit", args: {...} }.
  const innerTool = toolName === 'mcp' ? titleValue(input.tool) : undefined
  if (innerTool) return truncateTitle(`${toolName} ${toolTitle(innerTool, input.args)}`)

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
    return truncateToolOutput(diff)
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return truncateToolOutput(texts.join(''))
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
    return truncateToolOutput(parts.join('\n\n').trimEnd())
  }

  try {
    return truncateToolOutput(JSON.stringify(result, null, 2))
  } catch {
    return String(result)
  }
}
