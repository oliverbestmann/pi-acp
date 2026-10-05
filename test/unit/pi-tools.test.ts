import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultToText, toolTitle } from '../../src/acp/translate/pi-tools.js'

test('toolTitle: describes file, search, and custom tool inputs', () => {
  assert.equal(toolTitle('read', { path: 'src/acp/session.ts' }), 'read src/acp/session.ts')
  assert.equal(toolTitle('grep', { pattern: 'tool_call', path: 'src/acp' }), 'grep "tool_call" in src/acp')
  assert.equal(toolTitle('grep', { glob: '*.ts' }), 'grep *.ts')
  assert.equal(toolTitle('fetch_url', { url: 'https://example.test' }), 'fetch_url https://example.test')
  assert.equal(toolTitle('go_doc', { target: 'fmt.Println' }), 'go_doc fmt.Println')
  assert.equal(toolTitle('memory', { action: 'search', query: 'pi tool titles' }), 'memory search "pi tool titles"')
})

test('toolTitle: ignores unsafe or incomplete input and bounds titles', () => {
  assert.equal(toolTitle('write', { content: 'secret' }), 'write')
  assert.equal(toolTitle('grep', { partialArgs: '{"pattern":' }), 'grep')
  assert.equal(toolTitle('custom', { target: { nested: true } }), 'custom')
  assert.equal(toolTitle('read', { path: 'x'.repeat(200) }).length, 160)
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
