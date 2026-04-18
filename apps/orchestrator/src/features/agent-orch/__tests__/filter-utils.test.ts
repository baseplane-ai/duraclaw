import { describe, expect, it } from 'vitest'
import { getRecentAndOlder, isInDateRange } from '../FilterChipBar'

describe('isInDateRange', () => {
  it('returns true for "all" range', () => {
    expect(isInDateRange('2020-01-01', 'all')).toBe(true)
  })

  it('returns true for today sessions with "today" range', () => {
    expect(isInDateRange(new Date().toISOString(), 'today')).toBe(true)
  })

  it('returns false for old sessions with "today" range', () => {
    const old = new Date()
    old.setDate(old.getDate() - 5)
    expect(isInDateRange(old.toISOString(), 'today')).toBe(false)
  })

  it('includes yesterday in "yesterday" range', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(12, 0, 0, 0)
    expect(isInDateRange(yesterday.toISOString(), 'yesterday')).toBe(true)
  })

  it('excludes two days ago from "yesterday" range', () => {
    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)
    twoDaysAgo.setHours(0, 0, 0, 0)
    expect(isInDateRange(twoDaysAgo.toISOString(), 'yesterday')).toBe(false)
  })

  it('includes recent sessions in "this-week" range', () => {
    const threeDaysAgo = new Date()
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
    expect(isInDateRange(threeDaysAgo.toISOString(), 'this-week')).toBe(true)
  })

  it('excludes old sessions from "this-week" range', () => {
    const twoWeeksAgo = new Date()
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)
    expect(isInDateRange(twoWeeksAgo.toISOString(), 'this-week')).toBe(false)
  })

  it('includes recent sessions in "this-month" range', () => {
    const twoWeeksAgo = new Date()
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)
    expect(isInDateRange(twoWeeksAgo.toISOString(), 'this-month')).toBe(true)
  })

  it('excludes old sessions from "this-month" range', () => {
    const twoMonthsAgo = new Date()
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2)
    expect(isInDateRange(twoMonthsAgo.toISOString(), 'this-month')).toBe(false)
  })
})

describe('getRecentAndOlder', () => {
  it('puts all sessions in recent when range is "all"', () => {
    const sessions = [{ createdAt: '2020-01-01' }] as any
    const { recent, older } = getRecentAndOlder(sessions, 'all')
    expect(recent).toHaveLength(1)
    expect(older).toHaveLength(0)
  })

  it('splits sessions by date range', () => {
    const now = new Date()
    const old = new Date()
    old.setDate(old.getDate() - 30)
    const sessions = [{ createdAt: now.toISOString() }, { createdAt: old.toISOString() }] as any
    const { recent, older } = getRecentAndOlder(sessions, 'this-week')
    expect(recent).toHaveLength(1)
    expect(older).toHaveLength(1)
  })
})
