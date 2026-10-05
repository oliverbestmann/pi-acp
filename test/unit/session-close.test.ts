import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function registerFakeSession(agent: PiAcpAgent, sessionId: string, proc: FakePiRpcProcess): void {
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })
  ;(agent as any).sessions.sessions.set(sessionId, session)
}

test('PiAcpAgent: closeSession disposes the live pi process without touching the session file', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const proc = new FakePiRpcProcess()
  registerFakeSession(agent, 'live-session', proc)

  const response = await agent.closeSession({ sessionId: 'live-session' } as any)

  assert.deepEqual(response, {})
  assert.equal(proc.disposeCount, 1)
  assert.equal((agent as any).sessions.maybeGet('live-session'), undefined)
})

test('PiAcpAgent: closeSession is a no-op for an unknown sessionId', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const response = await agent.closeSession({ sessionId: 'no-such-session' } as any)

  assert.deepEqual(response, {})
})

test('PiAcpAgent: deleteSession also disposes a live pi process before removing its session file', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const proc = new FakePiRpcProcess()
  registerFakeSession(agent, 'stored-session', proc)
  ;(agent as any).store = {
    get(sessionId: string) {
      if (sessionId !== 'stored-session') return null
      return { sessionId, cwd: process.cwd(), sessionFile: null, updatedAt: new Date().toISOString() }
    },
    delete() {},
    upsert() {}
  }

  const response = await agent.deleteSession({ sessionId: 'stored-session' } as any)

  assert.deepEqual(response, {})
  assert.equal(proc.disposeCount, 1)
  assert.equal((agent as any).sessions.maybeGet('stored-session'), undefined)
})
