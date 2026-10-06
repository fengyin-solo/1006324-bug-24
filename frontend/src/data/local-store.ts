import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 附属存储：照明台账的审计轨迹、遗留清单、归置报告独立成项，主表与附属项同一次事务写入。
const sideCache = new Map<string, unknown>()

export function getSidecar<T>(key: string, fallback: T): T {
  if (!sideCache.has(key)) {
    if (typeof window === 'undefined' || !window.localStorage) {
      return clone(fallback)
    }
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      sideCache.set(key, clone(fallback))
      return clone(fallback)
    }
    try {
      sideCache.set(key, JSON.parse(raw) as T)
    } catch {
      sideCache.set(key, clone(fallback))
    }
  }
  return clone(sideCache.get(key) as T)
}

export function setSidecar(key: string, value: unknown): void {
  sideCache.set(key, clone(value))
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

export function removeSidecar(key: string): void {
  sideCache.delete(key)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(key)
  }
}

/**
 * 多仓原子提交：主表多个模块与附属存储要么一次全落，要么整体不落。
 * 先在内存里算好下一份快照，全部序列化成功后才写 localStorage，
 * 任一项写失败都恢复写入前状态，前后两次读到的必须是同一份数据。
 */
export function commitAtomic(
  entryUpdates: Record<string, EntryRow[]>,
  sidecarUpdates: Record<string, unknown> = {},
): void {
  const prevEntries = cache
  const prevSide = new Map(sideCache)
  const nextEntries = { ...allRows(), ...entryUpdates }
  let serialized = ''
  try {
    serialized = JSON.stringify(nextEntries)
    for (const [key, value] of Object.entries(sidecarUpdates)) {
      JSON.stringify(value) // 先验证可序列化，避免半写
    }
  } catch {
    cache = prevEntries
    throw new Error('数据未能完成序列化，整笔退回')
  }
  cache = nextEntries
  for (const [key, value] of Object.entries(sidecarUpdates)) {
    sideCache.set(key, clone(value))
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized)
      for (const [key, value] of Object.entries(sidecarUpdates)) {
        window.localStorage.setItem(key, JSON.stringify(value))
      }
    } catch (error) {
      // 落库没走完整套流程：恢复内存与存储，整笔退回
      cache = prevEntries
      sideCache.clear()
      prevSide.forEach((value, key) => sideCache.set(key, value))
      throw error
    }
  }
}
