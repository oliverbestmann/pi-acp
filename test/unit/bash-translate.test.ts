import test from 'node:test'
import assert from 'node:assert/strict'
import { bashOutputDelta, capBashOutput } from '../../src/acp/translate/bash.js'

test('capBashOutput: passes short output through unchanged', () => {
  assert.equal(capBashOutput('hello'), 'hello')
})

test('capBashOutput: caps long output and is stable across repeated growth', () => {
  const base = 'x'.repeat(25_000)
  const capped1 = capBashOutput(base)
  assert.ok(capped1.length < base.length)
  assert.match(capped1, /truncated, output exceeds \d+ characters/)

  // Simulate more output arriving in a later poll; the capped result must stay identical
  // so the delta stream naturally stops growing.
  const capped2 = capBashOutput(base + 'y'.repeat(5_000))
  assert.equal(capped1, capped2)
  assert.equal(bashOutputDelta(capped1, capped2), '')
})
