import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { shouldSuppressIncoming, suppressReason } from '../src/core/quiet.js'

const guest = { kind: 'aurabot', speaker: { role: 'guest', chat: 'group' } }
const owner = { kind: 'aurabot', speaker: { role: 'owner', chat: 'private' } }
const panel = { kind: 'aurabot', speaker: { role: 'none' } }

describe('quiet gate', () => {
  it('drops a guest aurabot turn inside the sleep window', () => {
    assert.equal(shouldSuppressIncoming({ source: guest, sleeping: true, blockGuest: true }), true)
  })

  it('lets the same turn through outside the window', () => {
    assert.equal(shouldSuppressIncoming({ source: guest, sleeping: false, blockGuest: true }), false)
  })

  it('lets it through when the switch is off', () => {
    assert.equal(shouldSuppressIncoming({ source: guest, sleeping: true, blockGuest: false }), false)
  })

  it('always lets the owner through', () => {
    assert.equal(shouldSuppressIncoming({ source: owner, sleeping: true, blockGuest: true }), false)
  })

  it('lets panel and system turns through', () => {
    assert.equal(shouldSuppressIncoming({ source: panel, sleeping: true, blockGuest: true }), false)
  })

  it('never touches other plugins or plain user turns', () => {
    assert.equal(
      shouldSuppressIncoming({ source: { kind: 'plugin:dsh-autonomy' }, sleeping: true, blockGuest: true }),
      false,
    )
    assert.equal(shouldSuppressIncoming({ source: { kind: 'user' }, sleeping: true, blockGuest: true }), false)
    assert.equal(shouldSuppressIncoming({ source: undefined, sleeping: true, blockGuest: true }), false)
  })

  it('names the chat in the reason', () => {
    const reason = suppressReason({ source: guest, sleeping: true, blockGuest: true })
    assert.match(String(reason), /sleep window, guest turn from group/)
    assert.equal(suppressReason({ source: guest, sleeping: false, blockGuest: true }), null)
  })
})
