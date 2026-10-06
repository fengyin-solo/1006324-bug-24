// 应用启动引导：在任何页面读取本地数据前，注册照明台账的上线前迁移。
// 迁移只跑一次（按 root.version 判定），幂等：重排号、补缺号、推定登记时间都在这里完成。

import { renumberLamps, type LightingLamp } from './lighting'
import { registerMigrator, STORE_VERSION, type StoredRoot } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 重置照明模块时也要落迁移后的种子：复用同一份重排逻辑，保证台账与清单同源。
export function migratedSeedLighting(seed: EntryRow[]): LightingLamp[] {
  return renumberLamps(seed)
}

registerMigrator((root: StoredRoot): StoredRoot => {
  if (root.version >= STORE_VERSION) {
    return root
  }
  const lamps = renumberLamps(root.modules.lighting ?? [])
  return {
    ...root,
    version: STORE_VERSION,
    modules: { ...root.modules, lighting: lamps as unknown as EntryRow[] },
    lightingReports: root.lightingReports ?? [],
  }
})