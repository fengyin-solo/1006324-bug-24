import { commitAtomic, getSidecar, listRows, resetRows } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import {
  CABIN_CODE,
  CABIN_ORDER,
  CABIN_OWNER,
  CABIN_POSITIONS,
  cabinInScope,
  canProcessReplacement,
  isLightingOwner,
  positionIndex,
  type Account,
} from '@/data/access'
import type { AuditEvent, EntryRow, LampRow, QuarantineItem } from '@/data/types'
import { filterRows } from './local-service'

// 照明台账附属存储：审计轨迹、退回遗留清单、上线归置报告，与主表同一事务落库。
const SIDE_KEY = 'urban-utility-tunnel:lighting-ledger'
const LEDGER_VERSION = 2
const ONLINE_TIME = '2026-10-06 09:00'

type LedgerSide = {
  version: number
  events: AuditEvent[]
  quarantine: QuarantineItem[]
  report: MigrationReport | null
  seq: { audit: number; quarantine: number }
}

export type RenumberRow = {
  code: string
  oldCode: string
  cabin: string
  position: string
  registeredAt: string
  basis: string
}

export type MigrationReport = {
  time: string
  rule: string
  accepted: number
  rejected: number
  damaged: number
  rows: RenumberRow[]
  rejectedItems: { rawCode: string; cabin: string; position: string; reason: string }[]
}

export type LightingBoard = {
  lamps: LampRow[]
  quarantined: QuarantineItem[]
  events: AuditEvent[]
  report: MigrationReport | null
  total: number
  damaged: number
  replacing: number
  pendingReplacement: number
  openMaintenance: number
  rejected: number
}

export type SubmitResult = { ok: boolean; message: string; codes?: string[] }

let clockOverride = ''

/** 测试可注入时间；页面操作默认取当前时刻。 */
export function setClock(time: string): void {
  clockOverride = time
}

function now(): string {
  if (clockOverride) {
    return clockOverride
  }
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function emptySide(): LedgerSide {
  return { version: 0, events: [], quarantine: [], report: null, seq: { audit: 0, quarantine: 0 } }
}

function readSide(): LedgerSide {
  return getSidecar<LedgerSide>(SIDE_KEY, emptySide())
}

// 上线前遗留动作：早年没有登记时间的灯具，按最早一次动作推定归位。
const LEGACY_EVENTS: Record<number, { action: string; time: string; operator: string; detail: string }[]> = {
  1: [{ action: '历史登记', time: '2026-03-04 08:20', operator: '张伟', detail: '随综合舱竣工登记' }],
  2: [{ action: '历史登记', time: '2026-03-04 09:10', operator: '张伟', detail: '随综合舱竣工登记' }],
  3: [
    { action: '历史登记', time: '2026-03-05 08:40', operator: '张伟', detail: '随综合舱竣工补登' },
    { action: '登记损坏', time: '2026-03-08 17:30', operator: '张伟', detail: '灯具不亮，待更换' },
  ],
  4: [{ action: '首次巡检', time: '2026-03-11 15:20', operator: '张伟', detail: '无验收日期，按首次巡检动作推定登记时间' }],
  5: [{ action: '历史登记', time: '2026-03-18 10:05', operator: '周俊', detail: '外包账号替登记账，无验收日期，按该次动作推定' }],
  7: [{ action: '历史登记', time: '2026-02-20 08:30', operator: '李娜', detail: '随电力舱竣工登记' }],
  8: [{ action: '历史登记', time: '2026-02-21 08:30', operator: '李娜', detail: '随电力舱竣工登记' }],
  9: [{ action: '首次巡检', time: '2026-03-01 16:40', operator: '李娜', detail: '无验收日期，按首次巡检动作推定登记时间' }],
  10: [{ action: '历史登记', time: '2026-03-15 09:00', operator: '李娜', detail: '电力舱后装段补登' }],
  12: [{ action: '历史登记', time: '2026-01-18 08:00', operator: '王强', detail: '随燃气舱竣工登记' }],
  13: [
    { action: '历史登记', time: '2026-01-19 08:15', operator: '王强', detail: '随燃气舱竣工登记' },
    { action: '登记损坏', time: '2026-02-01 11:10', operator: '周俊', detail: '灯具进水损坏' },
  ],
  14: [{ action: '历史登记', time: '2026-02-05 08:50', operator: '赵敏', detail: '随水信舱竣工登记' }],
  15: [{ action: '历史登记', time: '2026-02-06 08:50', operator: '赵敏', detail: '随水信舱竣工登记' }],
  16: [{ action: '历史登记', time: '2026-02-07 11:30', operator: '赵敏', detail: '随水信舱竣工登记' }],
}

function earliestLegacy(seedId: number): string {
  const events = LEGACY_EVENTS[seedId] ?? []
  return events.length ? events[0].time : ''
}

function isOpenLamp(status: string): boolean {
  return status === '已损坏' || status === '更换中'
}

function toLamp(row: EntryRow): LampRow {
  return row as LampRow
}

function findLamp(rows: EntryRow[], code: string): LampRow | undefined {
  return rows.find((row) => String(row.灯具编号) === code) as LampRow | undefined
}

/**
 * 上线归置（一次性、幂等）：
 * 1. 安装位置对不上目录的整条退回；2. 编号重号只留验收/推定最早的一份；
 * 3. 同舱同位置重复登记只留最早一份；4. 通过的按舱室顺序、安装位置顺序重新排号，
 *    舱室内从 001 连号，缺号自然补齐；5. 早年损坏同步生成检修待办。
 */
export function ensureLedger(): void {
  const side = readSide()
  if (side.version === LEDGER_VERSION) {
    return
  }
  migrateFromLegacy()
}

function migrateFromLegacy(): void {
  const legacy = SEED_ROWS.lighting.map((row) => ({ ...row }))
  const side = emptySide()
  const rejected: MigrationReport['rejectedItems'] = []
  const quarantined: QuarantineItem[] = []

  const pushQuarantine = (
    row: EntryRow,
    reason: string,
  ) => {
    side.seq.quarantine += 1
    quarantined.push({
      id: side.seq.quarantine,
      rawCode: String(row.灯具编号),
      cabin: String(row.所属舱室),
      position: String(row.安装位置),
      reason,
      source: '上线归置',
      operator: String(row.巡检人员 ?? ''),
      time: ONLINE_TIME,
    })
    rejected.push({
      rawCode: String(row.灯具编号),
      cabin: String(row.所属舱室),
      position: String(row.安装位置),
      reason,
    })
  }

  const accepted: EntryRow[] = []
  const seenCode = new Map<string, EntryRow>()
  for (const row of legacy) {
    const cabin = String(row.所属舱室)
    const position = String(row.安装位置)
    const code = String(row.灯具编号)
    if (!CABIN_POSITIONS[cabin] || positionIndex(cabin, position) < 0) {
      pushQuarantine(row, `安装位置「${position}」不属于${cabin}位置目录，位置对不上，整条退回`)
      continue
    }
    const duplicate = seenCode.get(code)
    if (duplicate) {
      pushQuarantine(row, `灯具编号「${code}」重号（另一条位于${String(duplicate.安装位置)}），重复编号只认最早一份，本条整条退回`)
      continue
    }
    seenCode.set(code, row)
    accepted.push(row)
  }

  // 同舱同位置重复登记：只认验收日期（无则按最早动作推定）最早的一份。
  const registeredAt = (row: EntryRow): string => {
    const acceptedDate = String(row.验收日期 ?? '').trim()
    if (acceptedDate) {
      return `${acceptedDate} 00:00`
    }
    return earliestLegacy(Number(row.id)) || String(row.巡检日期 ?? '')
  }
  const positionWinner = new Map<string, EntryRow>()
  for (const row of accepted) {
    const key = `${String(row.所属舱室)}@${String(row.安装位置)}`
    const prev = positionWinner.get(key)
    if (!prev || registeredAt(row) < registeredAt(prev)) {
      positionWinner.set(key, row)
    }
  }
  const winners = new Set<number>([...positionWinner.values()].map((row) => Number(row.id)))
  const survivors = accepted.filter((row) => winners.has(Number(row.id)))
  for (const row of accepted) {
    if (!winners.has(Number(row.id))) {
      pushQuarantine(
        row,
        `同舱同位置重复登记：${String(row.所属舱室)} ${String(row.安装位置)}已有更早一份，重复录入只认第一次，本条整条退回`,
      )
    }
  }

  // 归位排序：先舱室固定顺序，再按安装位置目录顺序；据此重新连号排号。
  survivors.sort((a, b) => {
    const ci = CABIN_ORDER.indexOf(String(a.所属舱室) as (typeof CABIN_ORDER)[number]) -
      CABIN_ORDER.indexOf(String(b.所属舱室) as (typeof CABIN_ORDER)[number])
    if (ci !== 0) {
      return ci
    }
    return positionIndex(String(a.所属舱室), String(a.安装位置)) -
      positionIndex(String(b.所属舱室), String(b.安装位置))
  })

  const renumberRows: RenumberRow[] = []
  const seqByCabin = new Map<string, number>()
  const lamps: EntryRow[] = survivors.map((row, index) => {
    const cabin = String(row.所属舱室)
    const seq = (seqByCabin.get(cabin) ?? 0) + 1
    seqByCabin.set(cabin, seq)
    const code = `ZM-${CABIN_CODE[cabin]}-${String(seq).padStart(3, '0')}`
    const at = registeredAt(row)
    const basis = String(row.验收日期 ?? '').trim() ? '按验收日期归位' : '无验收日期，按最早一次动作推定'
    renumberRows.push({
      code,
      oldCode: String(row.灯具编号),
      cabin,
      position: String(row.安装位置),
      registeredAt: at,
      basis,
    })
    const status = String(row.status)
    return {
      id: index + 1,
      status,
      pending: status !== '照明正常',
      abnormal: isOpenLamp(status),
      灯具编号: code,
      所属舱室: cabin,
      灯具类型: String(row.灯具类型),
      安装位置: String(row.安装位置),
      额定功率: String(row.额定功率),
      责任岗位: CABIN_OWNER[cabin],
      验收日期: String(row.验收日期 ?? ''),
      登记时间: at,
      原编号: String(row.灯具编号),
      照明状态: status,
      来源检修编号: '',
    } satisfies EntryRow
  })

  // 早年已损坏的灯具，归置同时把更换待办落到设施检修管理，检修班从那边接。
  const maintenance = listRows('maintenance').map((row) => ({ ...row }))
  let maintenanceSeq = maintenance.reduce((max, row) => Math.max(max, Number(row.id)), 0)
  for (const lamp of lamps) {
    if (lamp.status !== '已损坏') {
      continue
    }
    maintenanceSeq += 1
    const jobCode = `MAIN-${String(lamp.灯具编号)}`
    lamp.来源检修编号 = jobCode
    maintenance.push({
      id: maintenanceSeq,
      status: '待开工',
      pending: true,
      abnormal: false,
      检修编号: jobCode,
      检修对象: `照明灯具 ${String(lamp.灯具编号)}（${String(lamp.所属舱室)} ${String(lamp.安装位置)}）`,
      检修类别: '灯具更换',
      检修班组: '照明检修班',
      计划工期: '3个工作日',
      完工日期: '',
      更换部件: String(lamp.灯具类型),
      检修状态: '待开工',
      来源灯具编号: String(lamp.灯具编号),
      来源舱室: String(lamp.所属舱室),
    })
  }

  // 审计轨迹：遗留动作 + 上线归位，每盏灯谁动过都留底。
  for (const lamp of lamps) {
    const seedId = survivors.find((row) => String(row.灯具编号) === String(lamp.原编号))?.id
    for (const legacyEvent of LEGACY_EVENTS[Number(seedId)] ?? []) {
      side.seq.audit += 1
      side.events.push({
        id: side.seq.audit,
        lampCode: String(lamp.灯具编号),
        cabin: String(lamp.所属舱室),
        position: String(lamp.安装位置),
        action: legacyEvent.action,
        operator: legacyEvent.operator,
        operatorRole: legacyEvent.operator === CABIN_OWNER[String(lamp.所属舱室)] ? '照明责任岗' : '外包检修人员',
        time: legacyEvent.time,
        detail: legacyEvent.detail,
      })
    }
    side.seq.audit += 1
    side.events.push({
      id: side.seq.audit,
      lampCode: String(lamp.灯具编号),
      cabin: String(lamp.所属舱室),
      position: String(lamp.安装位置),
      action: '上线归置',
      operator: '系统',
      operatorRole: '归置迁移',
      time: ONLINE_TIME,
      detail: `原编号 ${String(lamp.原编号)} 按舱室与安装位置重排为 ${String(lamp.灯具编号)}，舱室内连号、缺号补齐`,
    })
  }
  side.events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id - b.id))

  side.quarantine = quarantined
  side.report = {
    time: ONLINE_TIME,
    rule: '按舱室固定顺序（综合/电力/燃气/水信）与舱内安装位置目录顺序重新排号，编号 ZM-舱码-三位序号，舱室内连号，缺号补齐；编号由系统分配，禁止手填。',
    accepted: lamps.length,
    rejected: quarantined.length,
    damaged: lamps.filter((lamp) => lamp.status === '已损坏').length,
    rows: renumberRows,
    rejectedItems: rejected,
  }
  side.version = LEDGER_VERSION

  commitAtomic({ lighting: lamps, maintenance }, { [SIDE_KEY]: side })
}

/** 重置照明台账：清掉归置结果，回到示例遗留数据后重新走一遍上线归置。 */
export function resetLedger(): void {
  resetRows('maintenance')
  resetRows('lighting')
  const side = emptySide()
  commitAtomic({}, { [SIDE_KEY]: side })
  migrateFromLegacy()
}

function openMaintenanceJobs(maintenance: EntryRow[]): EntryRow[] {
  return maintenance.filter(
    (row) => String(row.来源灯具编号 ?? '') !== '' && String(row.status) !== '已完工',
  )
}

/** 照明台账看板：列表、遗留清单、审计、检修待办同一次读取同一存储快照，条数天然对得上。 */
export function lightingBoard(filters: Record<string, string> = {}): LightingBoard {
  ensureLedger()
  const lamps = listRows('lighting').map(toLamp)
  const maintenance = listRows('maintenance')
  const side = readSide()
  const visible = filterRows(lamps as EntryRow[], filters).map(toLamp)
  const damaged = lamps.filter((lamp) => lamp.status === '已损坏').length
  const replacing = lamps.filter((lamp) => lamp.status === '更换中').length
  return {
    lamps: visible,
    quarantined: side.quarantine,
    events: side.events,
    report: side.report,
    total: lamps.length,
    damaged,
    replacing,
    pendingReplacement: damaged + replacing,
    openMaintenance: openMaintenanceJobs(maintenance).length,
    rejected: side.quarantine.length,
  }
}

export function lampDetail(code: string): { lamp: LampRow; events: AuditEvent[]; job?: EntryRow } | null {
  ensureLedger()
  const lamp = findLamp(listRows('lighting'), code)
  if (!lamp) {
    return null
  }
  const side = readSide()
  const job = listRows('maintenance').find((row) => String(row.检修编号) === String(lamp.来源检修编号))
  return {
    lamp,
    events: side.events.filter((event) => event.lampCode === code),
    job,
  }
}

function scopeConflict(account: Account, cabin: string, code: string): string {
  const owner = CABIN_OWNER[cabin] ?? '未设岗'
  const scope = account.cabins.length ? account.cabins.join('、') : '无归属舱室'
  return `归属冲突：灯具 ${code} 归属${cabin}（照明责任岗 ${owner}），${account.name}（${account.roleLabel}）授权范围为「${scope}」，归属之外的操作一律驳回`
}

function recordRejections(side: LedgerSide, items: { rawCode: string; cabin: string; position: string; reason: string; operator: Account; source: string }[]): LedgerSide {
  const next: LedgerSide = {
    ...side,
    seq: { ...side.seq },
    quarantine: [...side.quarantine],
    events: [...side.events],
  }
  for (const item of items) {
    next.seq.quarantine += 1
    next.quarantine.push({
      id: next.seq.quarantine,
      rawCode: item.rawCode,
      cabin: item.cabin,
      position: item.position,
      reason: item.reason,
      source: item.source,
      operator: item.operator.name,
      time: now(),
    })
  }
  return next
}

export type DamageItem = { lampCode: string; description: string }

/**
 * 受控损坏登记：岗位+归属双重校验，编号、位置、重复登记逐条拦截；
 * 任一条不通过整笔退回（不写台账、不生待办），只把退回原因留进遗留清单；
 * 全部通过才同一事务落库：灯具状态、检修待办、审计一次成型。
 */
export function registerDamageBatch(account: Account, items: DamageItem[]): SubmitResult {
  ensureLedger()
  if (!isLightingOwner(account)) {
    return {
      ok: false,
      message: `归属冲突：${account.name}（${account.roleLabel}）不是照明责任岗，损坏登记仅对本舱室照明责任岗开放，该操作一律驳回`,
    }
  }
  if (!items.length) {
    return { ok: false, message: '没有选择任何灯具，整笔退回' }
  }

  const lamps = listRows('lighting').map((row) => ({ ...row }))
  const maintenance = listRows('maintenance').map((row) => ({ ...row }))
  const conflicts: { rawCode: string; cabin: string; position: string; reason: string }[] = []
  const batchCodes = new Set<string>()

  for (const item of items) {
    const code = item.lampCode.trim()
    const lamp = findLamp(lamps, code)
    if (!lamp) {
      conflicts.push({ rawCode: code, cabin: '', position: '', reason: `灯具编号「${code}」不在照明台账，不许入账` })
      continue
    }
    const cabin = String(lamp.所属舱室)
    const position = String(lamp.安装位置)
    if (batchCodes.has(code)) {
      conflicts.push({ rawCode: code, cabin, position, reason: `本笔提交内灯具 ${code} 重复出现，同一盏灯不能重复登记` })
      continue
    }
    batchCodes.add(code)
    if (!cabinInScope(account, cabin)) {
      conflicts.push({ rawCode: code, cabin, position, reason: scopeConflict(account, cabin, code) })
      continue
    }
    const existed = maintenance.find(
      (row) => String(row.来源灯具编号 ?? '') === code && String(row.status) !== '已完工',
    )
    if (existed) {
      conflicts.push({
        rawCode: code,
        cabin,
        position,
        reason: `灯具 ${code}（${cabin} ${position}）已有损坏登记与检修待办 ${String(existed.检修编号)}，重复录入只认第一次的那份，本条整条退回，条数不叠加`,
      })
      continue
    }
    if (lamp.status === '已损坏' || lamp.status === '更换中') {
      conflicts.push({ rawCode: code, cabin, position, reason: `灯具 ${code} 当前为「${lamp.status}」，同一盏灯不能重复登记损坏` })
    }
  }

  const side = readSide()
  if (conflicts.length) {
    const nextSide = recordRejections(
      side,
      conflicts.map((c) => ({ ...c, operator: account, source: '损坏登记' })),
    )
    // 整笔退回：主表一个字不动，仅遗留清单留痕。
    commitAtomic({}, { [SIDE_KEY]: nextSide })
    return { ok: false, message: `登记 ${items.length} 盏、冲突 ${conflicts.length} 条，整笔退回。首条：${conflicts[0].reason}` }
  }

  let maintenanceSeq = maintenance.reduce((max, row) => Math.max(max, Number(row.id)), 0)
  const nextEvents: AuditEvent[] = []
  let auditSeq = side.seq.audit
  const acceptedCodes: string[] = []
  for (const item of items) {
    const code = item.lampCode.trim()
    const index = lamps.findIndex((row) => String(row.灯具编号) === code)
    const lamp = toLamp(lamps[index])
    lamp.status = '已损坏'
    lamp.照明状态 = '已损坏'
    lamp.pending = true
    lamp.abnormal = true
    maintenanceSeq += 1
    const jobCode = `MAIN-${code}`
    lamp.来源检修编号 = jobCode
    maintenance.push({
      id: maintenanceSeq,
      status: '待开工',
      pending: true,
      abnormal: false,
      检修编号: jobCode,
      检修对象: `照明灯具 ${code}（${String(lamp.所属舱室)} ${String(lamp.安装位置)}）`,
      检修类别: '灯具更换',
      检修班组: '照明检修班',
      计划工期: '3个工作日',
      完工日期: '',
      更换部件: String(lamp.灯具类型),
      检修状态: '待开工',
      来源灯具编号: code,
      来源舱室: String(lamp.所属舱室),
    })
    auditSeq += 1
    nextEvents.push({
      id: auditSeq,
      lampCode: code,
      cabin: String(lamp.所属舱室),
      position: String(lamp.安装位置),
      action: '登记损坏',
      operator: account.name,
      operatorRole: account.roleLabel,
      time: now(),
      detail: item.description.trim() || '巡检发现灯具损坏，提交更换',
    })
    acceptedCodes.push(code)
  }

  const nextSide: LedgerSide = {
    ...side,
    seq: { ...side.seq, audit: auditSeq },
    events: [...side.events, ...nextEvents],
  }
  commitAtomic({ lighting: lamps, maintenance }, { [SIDE_KEY]: nextSide })
  return {
    ok: true,
    codes: acceptedCodes,
    message: `已登记 ${acceptedCodes.length} 盏损坏灯具，更换待办同步落到设施检修管理（${acceptedCodes.map((c) => `MAIN-${c}`).join('、')}），台账与待办同一份数据`,
  }
}

export type LampDraft = {
  cabin: string
  lampType: string
  position: string
  power: string
  acceptedDate: string
}

/** 补录新灯：归属校验 + 位置目录校验 + 位置占用校验，编号系统按舱内最小空号分配，杜绝重号。 */
export function registerLamp(account: Account, draft: LampDraft): SubmitResult {
  ensureLedger()
  if (!isLightingOwner(account)) {
    return { ok: false, message: `归属冲突：${account.name}（${account.roleLabel}）不是照明责任岗，补录入口一律驳回` }
  }
  const cabin = draft.cabin.trim()
  if (!cabinInScope(account, cabin)) {
    const scope = account.cabins.join('、') || '无归属舱室'
    return { ok: false, message: `归属冲突：${account.name}（${account.roleLabel}）授权范围为「${scope}」，不得向${cabin || '其他舱室'}补录灯具` }
  }
  const position = draft.position.trim()
  if (positionIndex(cabin, position) < 0) {
    return { ok: false, message: `安装位置「${position}」不在${cabin}位置目录（${CABIN_POSITIONS[cabin].join('、')}）内，位置对不上，不许入账` }
  }
  const lamps = listRows('lighting').map((row) => ({ ...row }))
  if (lamps.some((row) => String(row.所属舱室) === cabin && String(row.安装位置) === position)) {
    return { ok: false, message: `${cabin} ${position} 已有一盏在册灯具，同一位置不能重复入账` }
  }
  const used = new Set(
    lamps
      .filter((row) => String(row.所属舱室) === cabin)
      .map((row) => Number(String(row.灯具编号).split('-').pop())),
  )
  let seq = 1
  while (used.has(seq)) {
    seq += 1
  }
  const code = `ZM-${CABIN_CODE[cabin]}-${String(seq).padStart(3, '0')}`
  const id = lamps.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const acceptedDate = draft.acceptedDate.trim()
  lamps.push({
    id,
    status: '待巡检',
    pending: true,
    abnormal: false,
    灯具编号: code,
    所属舱室: cabin,
    灯具类型: draft.lampType.trim() || 'LED防潮灯',
    安装位置: position,
    额定功率: draft.power.trim() || '36W',
    责任岗位: CABIN_OWNER[cabin],
    验收日期: acceptedDate,
    登记时间: now(),
    原编号: '',
    照明状态: '待巡检',
    来源检修编号: '',
  })

  const side = readSide()
  const auditSeq = side.seq.audit + 1
  const nextSide: LedgerSide = {
    ...side,
    seq: { ...side.seq, audit: auditSeq },
    events: [
      ...side.events,
      {
        id: auditSeq,
        lampCode: code,
        cabin,
        position,
        action: '补录入账',
        operator: account.name,
        operatorRole: account.roleLabel,
        time: now(),
        detail: acceptedDate ? `验收日期 ${acceptedDate}，补录入账` : '无验收日期，以本次补录动作为登记时间',
      },
    ],
  }
  commitAtomic({ lighting: lamps }, { [SIDE_KEY]: nextSide })
  return { ok: true, codes: [code], message: `灯具已补录入账：${code}（${cabin} ${position}），编号取舱内最小空号，不存在重号` }
}

const ACTION_TARGET: Record<string, string> = { 提交巡检: '巡检中', 判定正常: '照明正常', 登记损坏: '已损坏' }

/** 台账行状态流转：仍然走受控入口，归属之外的岗位一个动作都提交不上。 */
export function transitionLamp(account: Account, code: string, action: string): SubmitResult {
  ensureLedger()
  const lamps = listRows('lighting').map((row) => ({ ...row }))
  const lamp = findLamp(lamps, code)
  if (!lamp) {
    return { ok: false, message: `没有找到灯具 ${code}` }
  }
  const cabin = String(lamp.所属舱室)
  if (!cabinInScope(account, cabin)) {
    return { ok: false, message: scopeConflict(account, cabin, code) }
  }
  const target = ACTION_TARGET[action]
  if (!target) {
    return { ok: false, message: `照明灯具没有登记「${action}」这个动作` }
  }
  if (String(lamp.status) === target) {
    return { ok: false, message: `灯具 ${code} 已经是「${target}」，不用重复操作` }
  }
  lamp.status = target
  lamp.照明状态 = target
  lamp.pending = target !== '照明正常'
  lamp.abnormal = target === '已损坏'
  const side = readSide()
  const auditSeq = side.seq.audit + 1
  const nextSide: LedgerSide = {
    ...side,
    seq: { ...side.seq, audit: auditSeq },
    events: [
      ...side.events,
      {
        id: auditSeq,
        lampCode: code,
        cabin,
        position: String(lamp.安装位置),
        action,
        operator: account.name,
        operatorRole: account.roleLabel,
        time: now(),
        detail: `状态由责任岗位流转为「${target}」`,
      },
    ],
  }
  commitAtomic({ lighting: lamps }, { [SIDE_KEY]: nextSide })
  return { ok: true, message: `灯具 ${code} 已${action}，当前状态「${target}」` }
}

/** 检修班从设施检修管理承接灯具更换：开工与完工同时回写灯具台账，两边始终同步。 */
export function processReplacement(account: Account, jobId: number, action: '提交开工' | '确认完工'): SubmitResult {
  ensureLedger()
  if (!canProcessReplacement(account)) {
    return { ok: false, message: `归属冲突：${account.name}（${account.roleLabel}）不是照明检修班，灯具更换待办只对检修班开放，该操作驳回` }
  }
  const maintenance = listRows('maintenance').map((row) => ({ ...row }))
  const jobIndex = maintenance.findIndex((row) => Number(row.id) === jobId)
  const job = maintenance[jobIndex]
  if (!job || String(job.来源灯具编号 ?? '') === '') {
    return { ok: false, message: '没有找到对应的灯具更换待办' }
  }
  const code = String(job.来源灯具编号)
  const lamps = listRows('lighting').map((row) => ({ ...row }))
  const lamp = findLamp(lamps, code)
  if (!lamp) {
    return { ok: false, message: `待办 ${String(job.检修编号)} 关联的灯具 ${code} 已不在台账` }
  }
  const side = readSide()
  const auditSeq = side.seq.audit + 1
  let event: AuditEvent
  if (action === '提交开工') {
    if (String(job.status) !== '待开工') {
      return { ok: false, message: `待办 ${String(job.检修编号)} 当前为「${job.status}」，不能重复开工` }
    }
    job.status = '检修中'
    job.检修状态 = '检修中'
    job.pending = true
    lamp.status = '更换中'
    lamp.照明状态 = '更换中'
    lamp.pending = true
    lamp.abnormal = true
    event = {
      id: auditSeq, lampCode: code, cabin: String(lamp.所属舱室), position: String(lamp.安装位置),
      action: '开工更换', operator: account.name, operatorRole: account.roleLabel, time: now(),
      detail: `检修班承接待办 ${String(job.检修编号)}，灯具进入更换中`,
    }
  } else {
    if (String(job.status) === '已完工') {
      return { ok: false, message: `待办 ${String(job.检修编号)} 已完工，不用重复确认` }
    }
    job.status = '已完工'
    job.检修状态 = '已完工'
    job.pending = false
    job.完工日期 = now().slice(0, 10)
    lamp.status = '照明正常'
    lamp.照明状态 = '照明正常'
    lamp.pending = false
    lamp.abnormal = false
    event = {
      id: auditSeq, lampCode: code, cabin: String(lamp.所属舱室), position: String(lamp.安装位置),
      action: '更换完成', operator: account.name, operatorRole: account.roleLabel, time: now(),
      detail: `待办 ${String(job.检修编号)} 完工，灯具恢复照明正常，台账与检修清单同步更新`,
    }
  }
  const nextSide: LedgerSide = {
    ...side,
    seq: { ...side.seq, audit: auditSeq },
    events: [...side.events, event],
  }
  commitAtomic({ lighting: lamps, maintenance }, { [SIDE_KEY]: nextSide })
  return { ok: true, message: `${String(job.检修编号)}：${event.detail}` }
}
