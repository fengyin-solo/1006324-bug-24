import { SEED_ROWS } from './seed'
import type { DamageReport, LightingLamp } from '@/domain/lighting'
import type { EntryRow } from './types'

// 本地持久化：整份数据是一个 JSON 文档，一次 setItem 原子落库。
// 模块数据在 modules 下；照明损坏报修单单独放在 lightingReports 下，
// 与「照明灯具台账」「设施检修待办」在同一事务里提交，保证两边读到的永远是同一份。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
export const STORE_VERSION = 2

export type StoredRoot = {
  version: number
  modules: Record<string, EntryRow[]>
  lightingReports: DamageReport[]
}

type RawRoot = StoredRoot | Record<string, EntryRow[]>

// 迁移器在应用启动时注册：拿到旧版/种子根文档，返回升级后的根文档。
type Migrator = (root: StoredRoot) => StoredRoot
let migrator: Migrator | null = null

export function registerMigrator(fn: Migrator): void {
  migrator = fn
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function buildSeedRoot(): StoredRoot {
  // 种子先按旧版结构登记，交给注册好的迁移器做上线前重排号，保证首次打开与存量库走同一套流程。
  return {
    version: 1,
    modules: clone(SEED_ROWS),
    lightingReports: [],
  }
}

function isStoredRoot(raw: unknown): raw is StoredRoot {
  return typeof raw === 'object' && raw !== null && 'version' in raw && 'modules' in raw
}

// 老版本（含首次播种）落的是 module -> rows 的平铺结构，这里统一包成根文档。
function shapeRaw(raw: unknown): StoredRoot {
  if (isStoredRoot(raw)) {
    return {
      version: raw.version,
      modules: raw.modules,
      lightingReports: Array.isArray(raw.lightingReports) ? raw.lightingReports : [],
    }
  }
  return {
    version: 1,
    modules: clone((raw as Record<string, EntryRow[]>) ?? SEED_ROWS),
    lightingReports: [],
  }
}

let cache: StoredRoot | null = null

function readRoot(): StoredRoot {
  if (cache !== null) {
    return cache
  }
  let root: StoredRoot
  if (typeof window === 'undefined' || !window.localStorage) {
    root = buildSeedRoot()
  } else {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      root = buildSeedRoot()
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
    } else {
      try {
        root = shapeRaw(JSON.parse(raw) as RawRoot)
      } catch {
        root = buildSeedRoot()
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
      }
    }
  }
  if (root.version < STORE_VERSION && migrator) {
    root = migrator(clone(root))
    persist(root)
  }
  cache = root
  return root
}

function persist(root: StoredRoot): void {
  cache = root
  if (typeof window !== 'undefined' && window.localStorage) {
    // 整笔提交：只写这一次，任何调用方都不会留下跨 key 的半截数据。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
  }
}

export function allRows(): Record<string, EntryRow[]> {
  return readRoot().modules
}

export function listRows(key: string): EntryRow[] {
  return readRoot().modules[key] ?? []
}

// 通用模块写入：仍然走整份根文档的一次落库。
export function saveRows(key: string, rows: EntryRow[]): void {
  const root = readRoot()
  persist({ ...root, modules: { ...root.modules, [key]: rows } })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 照明域事务视图：灯具、报修单、检修待办取自同一份根文档。
export type LightingTransactionState = {
  lamps: LightingLamp[]
  reports: DamageReport[]
  maintenance: EntryRow[]
}

export function getLightingState(): LightingTransactionState {
  const root = readRoot()
  return {
    lamps: (root.modules.lighting ?? []) as unknown as LightingLamp[],
    reports: root.lightingReports,
    maintenance: root.modules.maintenance ?? [],
  }
}

// 照明域整笔提交：灯具台账、报修单、设施检修记录在一次 persist 里一起换版。
export function commitLightingState(state: LightingTransactionState): void {
  const root = readRoot()
  persist({
    ...root,
    modules: {
      ...root.modules,
      lighting: state.lamps as unknown as EntryRow[],
      maintenance: state.maintenance,
    },
    lightingReports: state.reports,
  })
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 仅供自检脚本使用：清掉内存根文档，下一次读取会重新从 localStorage 走迁移。
export function __resetStoreCacheForTest(): void {
  cache = null
}
