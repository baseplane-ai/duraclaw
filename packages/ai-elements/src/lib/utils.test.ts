import { describe, expect, it } from 'vitest'
import { cn, getPageNumbers, parseJsonField, sleep } from './utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible')
  })

  it('deduplicates tailwind classes via twMerge', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('')
  })

  it('handles undefined and null inputs', () => {
    expect(cn('foo', undefined, null, 'bar')).toBe('foo bar')
  })
})

describe('sleep', () => {
  it('resolves after the specified duration', async () => {
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it('defaults to 1000ms', () => {
    const promise = sleep()
    expect(promise).toBeInstanceOf(Promise)
  })
})

describe('parseJsonField', () => {
  it('returns default for null', () => {
    expect(parseJsonField(null, [])).toEqual([])
  })

  it('returns default for undefined', () => {
    expect(parseJsonField(undefined, 'fallback')).toBe('fallback')
  })

  it('parses a JSON string', () => {
    expect(parseJsonField('{"a":1}', {})).toEqual({ a: 1 })
  })

  it('parses a JSON array string', () => {
    expect(parseJsonField('[1,2,3]', [])).toEqual([1, 2, 3])
  })

  it('returns default for invalid JSON string', () => {
    expect(parseJsonField('not-json', 'default')).toBe('default')
  })

  it('returns default when JSON string is "null"', () => {
    expect(parseJsonField('null', 'default')).toBe('default')
  })

  it('returns the value directly if already an object', () => {
    const obj = { key: 'value' }
    expect(parseJsonField(obj, {})).toBe(obj)
  })

  it('returns default array when value is empty object and default is array', () => {
    expect(parseJsonField({}, [])).toEqual([])
  })

  it('returns object when value is non-empty object and default is array', () => {
    const obj = { a: 1 }
    expect(parseJsonField(obj, [])).toEqual({ a: 1 })
  })
})

describe('getPageNumbers', () => {
  it('returns all pages when totalPages <= 5', () => {
    expect(getPageNumbers(1, 3)).toEqual([1, 2, 3])
    expect(getPageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('shows ellipsis at end when near beginning', () => {
    expect(getPageNumbers(1, 10)).toEqual([1, 2, 3, 4, '...', 10])
    expect(getPageNumbers(3, 10)).toEqual([1, 2, 3, 4, '...', 10])
  })

  it('shows ellipsis at start when near end', () => {
    expect(getPageNumbers(9, 10)).toEqual([1, '...', 7, 8, 9, 10])
    expect(getPageNumbers(10, 10)).toEqual([1, '...', 7, 8, 9, 10])
  })

  it('shows ellipsis on both sides when in middle', () => {
    expect(getPageNumbers(5, 10)).toEqual([1, '...', 4, 5, 6, '...', 10])
  })

  it('handles single page', () => {
    expect(getPageNumbers(1, 1)).toEqual([1])
  })
})
