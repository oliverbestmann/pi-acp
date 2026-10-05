import test from 'node:test'
import assert from 'node:assert/strict'
import { toolInputContent, toolResultToText, toolTitle } from '../../src/acp/translate/pi-tools.js'

test('toolTitle: describes file, search, and custom tool inputs', () => {
  assert.equal(toolTitle('read', { path: 'src/acp/session.ts' }), 'read src/acp/session.ts')
  assert.equal(toolTitle('grep', { pattern: 'tool_call', path: 'src/acp' }), 'grep "tool_call" in src/acp')
  assert.equal(toolTitle('grep', { glob: '*.ts' }), 'grep *.ts')
  assert.equal(toolTitle('fetch_url', { url: 'https://example.test' }), 'fetch_url https://example.test')
  assert.equal(toolTitle('go_doc', { target: 'fmt.Println' }), 'go_doc fmt.Println')
  assert.equal(toolTitle('memory', { action: 'search', query: 'pi tool titles' }), 'memory search "pi tool titles"')
  assert.equal(
    toolTitle('mcp', { tool: 'jflow_commit', args: { message: 'test', path: '/home/oliver/github/jflow' } }),
    'mcp jflow_commit /home/oliver/github/jflow'
  )
})

test('toolTitle: ignores unsafe or incomplete input and bounds titles', () => {
  assert.equal(toolTitle('write', { content: 'secret' }), 'write')
  assert.equal(toolTitle('grep', { partialArgs: '{"pattern":' }), 'grep')
  assert.equal(toolTitle('custom', { target: { nested: true } }), 'custom')
  assert.equal(toolTitle('read', { path: 'x'.repeat(200) }).length, 160)
})

test('toolInputContent: renders question options as wrapped text, not raw JSON', () => {
  const content = toolInputContent('ask_user_question', {
    questions: [
      {
        question: 'Which approach?',
        options: [
          { label: 'A', description: 'Do the simple thing' },
          { label: 'B', description: 'Do the complex thing' }
        ]
      }
    ]
  })

  assert.deepEqual(content, [
    {
      type: 'content',
      content: {
        type: 'text',
        text: 'Which approach?\n1. A — Do the simple thing\n2. B — Do the complex thing'
      }
    }
  ])
})

test('toolInputContent: ignores unrelated tools and empty/malformed args', () => {
  assert.equal(toolInputContent('read', { path: 'a.ts' }), undefined)
  assert.equal(toolInputContent('ask_user_question', {}), undefined)
  assert.equal(toolInputContent('ask_user_question', { questions: [] }), undefined)
  assert.equal(toolInputContent('ask_user_question', null), undefined)
})

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultToText: truncates very long output, keeping head and tail', () => {
  const long = 'A'.repeat(15_000) + 'MIDDLE' + 'B'.repeat(15_000)
  const text = toolResultToText({ content: [{ type: 'text', text: long }] })
  assert.ok(text.length < long.length)
  assert.match(text, /^A+/)
  assert.match(text, /B+$/)
  assert.match(text, /truncated \d+ characters/)
  assert.doesNotMatch(text, /MIDDLE/)
})
