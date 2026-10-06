import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitLightingState, getLightingState, listRows, resetRows, saveRows } from '@/data/local-store'
import { migratedSeedLighting } from '@/domain/bootstrap'
import type { DamageReport, LightingLamp } from '@/domain/lighting'
import { SEED_ROWS } from '@/data/seed'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 照明损坏上报后，未完成的更换待办只有这一份数据：
// 照明页提示、设施检修管理待办、运维值班遗留清单都从这里读，三处条数必然一致。
export type ReplacementTodo = {
  report: DamageReport
  lamp: LightingLamp | undefined
  maintenance: EntryRow | undefined
}

export function listReplacementTodos(): ReplacementTodo[] {
  const state = getLightingState()
  return state.reports
    .filter((report) => !report.closed)
    .map((report) => ({
      report,
      lamp: state.lamps.find((lamp) => lamp.id === report.lampId),
      maintenance: state.maintenance.find((row) => Number(row.id) === report.maintenanceId),
    }))
}

// 灯具详情面板用的全量报修单（含已更换完成的）。
export function listLightingReports(): DamageReport[] {
  return getLightingState().reports
}

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  // 照明灯具的状态改动只接受控入口（归属岗位登记损坏 / 检修班完工更换），
  // 授权范围之外的账号从通用动作入口一律驳回，台账不留越权改动。
  if (key === 'lighting') {
    return { ok: false, message: '受控拦截：照明灯具的改动只接受控入口（本舱室照明责任岗位登记损坏、检修班完工更换），通用动作入口只读' }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  // 由照明损坏报修派生的检修记录，其状态必须随报修单闭环，避免待办与遗留条数对不上。
  if (key === 'maintenance' && rows[index]['来源类型'] === '照明损坏报修') {
    return { ok: false, message: '受控拦截：该检修记录来自照明损坏报修，完工确认由检修班在「照明更换待办」入口操作，通用动作入口驳回' }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  if (key === 'lighting') {
    // 照明域整笔重置：灯具回到上线前重排后的种子，报修单整笔清空，
    // 由报修派生的检修待办一并移除，三处条数仍对得上。
    const seedLamps = migratedSeedLighting(SEED_ROWS.lighting ?? [])
    const state = getLightingState()
    const linkedIds = new Set(
      state.reports.map((report) => report.maintenanceId),
    )
    commitLightingState({
      lamps: seedLamps,
      reports: [],
      maintenance: state.maintenance.filter((row) => !linkedIds.has(Number(row.id))),
    })
    return listEntries(key)
  }
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
