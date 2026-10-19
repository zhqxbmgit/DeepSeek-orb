import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PASTE_SEPARATOR, mergePastedText } from '../assets/composer-text.js'

describe('paste into the composer', () => {
  it('puts the clipboard text into an empty composer', () => {
    assert.deepEqual(mergePastedText('', 'fix the login test', 8000), {
      text: 'fix the login test',
      inserted: true,
      truncated: false,
      appended: false,
    })
  })

  it('keeps the draft and appends after a blank line', () => {
    const merged = mergePastedText('first task', 'second task', 8000)
    assert.equal(merged.text, `first task${PASTE_SEPARATOR}second task`)
    assert.equal(merged.appended, true)
    assert.equal(merged.inserted, true)
  })

  it('does not double a newline the draft already ends with', () => {
    assert.equal(mergePastedText('first task\n', 'second task', 8000).text, 'first task\nsecond task')
  })

  it('truncates at the composer limit and says so', () => {
    const merged = mergePastedText('draft', 'abcdefghij', 12)
    // 5 for the draft + 2 for the separator leave 5 characters.
    assert.equal(merged.text, 'draft\n\nabcde')
    assert.equal(merged.truncated, true)
    assert.equal(merged.inserted, true)
  })

  it('leaves the draft untouched when the limit is already reached', () => {
    assert.deepEqual(mergePastedText('12345', 'more', 5), {
      text: '12345',
      inserted: false,
      truncated: true,
      appended: true,
    })
  })

  it('answers an empty clipboard without touching the draft', () => {
    assert.deepEqual(mergePastedText('draft', '', 8000), {
      text: 'draft',
      inserted: false,
      truncated: false,
      appended: true,
    })
  })
})
