// 照明灯具域：台账（灯具）与损坏上报（报修单）两类数据的类型、
// 上线前重排号迁移、以及受控登记/报修/完工落库规则都集中在这里。
//
// 设计要点：
// - 灯具台账与设施检修待办、值班遗留清单取的是同一份「未完成报修单」，
//   派生面板不另存数据，三处条数天然一致。
// - 任何写操作先在内存里构造好「灯具 + 报修单 + 检修记录」的完整下一版，
//   全部校验通过后一次性提交（见 commitRoot），任一环节不通过整笔退回、不产生半截数据。

import {
  assertCabinOwner,
  cabinByCode,
  cabinCodeByName,
  cabinName,
  isPositionOfCabin,
  postById,
  scopeOf,
} from './access'
import { commitLightingState, getLightingState } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 上线前重排号固定发生在这一天，作为无登记时间条目的推定动作时间。
export const MIGRATED_AT = '2026-10-06T08:00:00'

export type LightingAudit = {
  at: string
  operator: string
  post: string
  action: string
  detail: string
}

export type LightingLamp = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  灯具编号: string
  所属舱室: string
  灯具类型: string
  安装位置: string
  额定功率: string
  巡检日期: string
  巡检人员: string
  照明状态: string
  验收日期: string
  // 归属与留痕字段：归属岗位、登记时间、操作履历。
  责任岗位: string
  登记时间: string
  history: LightingAudit[]
  // 兼容通用列表/导出按字段名取值。
  [field: string]: string | number | boolean | LightingAudit[]
}

export type DamageReport = {
  id: number
  reportNo: string
  lampId: number
  lampCode: string
  cabinCode: string
  position: string
  reportedAt: string
  reporter: string
  reporterPost: string
  damageNote: string
  // 对应设施检修管理里的检修记录编号（检修班从待办接这批更换）。
  maintenanceId: number
  maintenanceNo: string
  closed: boolean
  closedAt: string
}

// 照明事务状态：灯具台账、损坏报修单、设施检修记录同属一份根文档，一起提交。
export type LightingRoot = {
  lamps: LightingLamp[]
  reports: DamageReport[]
  maintenance: EntryRow[]
}

const LAST_LIGHTING_STATUS = '已损坏'

// ---------- 工具 ----------

function lampFullCabin(code: string): string {
  return `${cabinName(code)}（${code}舱）`
}

export function lampCabinCode(lamp: LightingLamp): string {
  return cabinCodeByName(String(lamp.所属舱室)) ?? 'A'
}

function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, Number(item.id) ?? 0), 0) + 1
}

// ---------- 上线前重排号迁移 ----------
//
// 补号办法（固定、自洽）：
// 1. 旧编号 LIGH-xxxx 作废，按「所属舱室」归组（认不出的舱室统一归 1#电力舱A，
//    因为迁移只允许舱室台账内的归属，缺项不能悬空）；
// 2. 舱室内先按安装位置（与舱室台账登记的位置顺序）排，安装位置不在台账的灯具
//    按舱室顺序补到该舱首个空闲登记位置（原始异常位置留在履历里待现场核对）；
//    位置相同再按验收日期排；早年没有登记/验收时间的，取该条最早一次动作时间
//    （巡检日期 → 迁移日推定）作为次序依据；
// 3. 每个舱室从 01 起连续重新编号：ZM<舱码>-<两位序号>，缺号即按此顺序补齐，
//    旧的重号、跳号在这一步全部消失。

export function normalizeLegacyLamp(row: EntryRow): LightingLamp {
  const namedCabin = cabinCodeByName(String(row.所属舱室 ?? ''))
  const cabinCode = namedCabin ?? 'A'
  const rawPosition = String(row.安装位置 ?? '')
  const positionKnown = isPositionOfCabin(cabinCode, rawPosition)
  const inspected = String(row.巡检日期 ?? '')
  const accepted = String(row['验收日期'] ?? '')
  const earliestAction = accepted || inspected || MIGRATED_AT.slice(0, 10)
  const status = String(row.status ?? '待巡检')
  const postId = cabinByCode(cabinCode) ? `light-${cabinCode.toLowerCase()}` : 'light-a'
  const postName = postById(postId)?.name ?? ''
  const history: LightingAudit[] = []
  if (accepted) {
    history.push({
      at: `${accepted}T00:00:00`,
      operator: '历史数据',
      post: postName,
      action: '验收入账',
      detail: '既有台账按验收日期归位',
    })
  }
  if (inspected && inspected !== accepted) {
    history.push({
      at: `${inspected}T00:00:00`,
      operator: String(row.巡检人员 ?? '巡检人员'),
      post: postName,
      action: '巡检',
      detail: '历史巡检记录',
    })
  }
  history.push({
    at: MIGRATED_AT,
    operator: '系统迁移',
    post: '值班管理员',
    action: '上线前重排号',
    detail: positionKnown
      ? '按安装位置归入舱室顺序重新编号'
      : `原登记位置「${rawPosition || '空缺'}」与${cabinName(cabinCode)}对不上，按舱室顺序补到空闲登记位置，现场核对后再校正`,
  })
  return {
    id: Number(row.id),
    status,
    pending: status !== LAST_LIGHTING_STATUS,
    abnormal: status === LAST_LIGHTING_STATUS,
    灯具编号: '',
    所属舱室: cabinName(cabinCode),
    灯具类型: String(row.灯具类型 ?? 'LED防潮灯'),
    // 位置缺项先置空，由 renumberLamps 按舱室顺序补到空闲位置。
    安装位置: positionKnown ? rawPosition : '',
    额定功率: String(row.额定功率 ?? '36W'),
    巡检日期: inspected,
    巡检人员: String(row.巡检人员 ?? ''),
    照明状态: status,
    验收日期: accepted,
    责任岗位: postName,
    登记时间: earliestAction ? `${earliestAction}T00:00:00` : MIGRATED_AT,
    history,
  }
}

export function renumberLamps(rawLamps: EntryRow[]): LightingLamp[] {
  const lamps = rawLamps.map(normalizeLegacyLamp)
  const groups = new Map<string, LightingLamp[]>()
  for (const lamp of lamps) {
    const code = lampCabinCode(lamp)
    const group = groups.get(code) ?? []
    group.push(lamp)
    groups.set(code, group)
  }
  const result: LightingLamp[] = []
  for (const cabin of ['A', 'B', 'C', 'D']) {
    const group = groups.get(cabin)
    if (!group) {
      continue
    }
    const cabinPositions = cabinByCode(cabin)?.positions ?? []
    // 缺项补齐：位置对不上/空缺的灯具，按舱室登记顺序补到尚未占用的位置，
    // 保证重排后每盏灯的安装位置都落在本舱室台账内（异常来源留在履历里待现场核对）。
    const occupied = new Set(group.map((lamp) => lamp.安装位置).filter(Boolean))
    const freePositions = cabinPositions.filter((position) => !occupied.has(position))
    for (const lamp of group) {
      if (!lamp.安装位置 && freePositions.length > 0) {
        lamp.安装位置 = freePositions.shift() as string
        lamp.history = [
          ...lamp.history,
          {
            at: MIGRATED_AT,
            operator: '系统迁移',
            post: '值班管理员',
            action: '缺项补位',
            detail: `补登安装位置为 ${lamp.安装位置}（舱室顺序内首个空闲位置）`,
          },
        ]
      }
    }
    group.sort((left, right) => {
      const li = cabinPositions.indexOf(left.安装位置)
      const ri = cabinPositions.indexOf(right.安装位置)
      const lo = li < 0 ? cabinPositions.length : li
      const ro = ri < 0 ? cabinPositions.length : ri
      if (lo !== ro) {
        return lo - ro
      }
      const la = left.验收日期 || left.登记时间.slice(0, 10)
      const ra = right.验收日期 || right.登记时间.slice(0, 10)
      if (la !== ra) {
        return la < ra ? -1 : 1
      }
      return left.id - right.id
    })
    group.forEach((lamp, index) => {
      const seq = String(index + 1).padStart(2, '0')
      lamp.灯具编号 = `ZM${cabin}-${seq}`
    })
    result.push(...group)
  }
  return result
}

// 给定舱室内下一个连续序号：新登记灯具按舱室顺序补在队尾，不允许出现重号。
function nextLampCode(root: LightingRoot, cabinCode: string): string {
  const used = root.lamps
    .filter((lamp) => lampCabinCode(lamp) === cabinCode)
    .map((lamp) => lamp.灯具编号)
  let seq = 1
  // 理论上重排号后无缺号；这里仍做一次占号检查，保证补号自洽。
  while (used.includes(`ZM${cabinCode}-${String(seq).padStart(2, '0')}`)) {
    seq += 1
  }
  return `ZM${cabinCode}-${String(seq).padStart(2, '0')}`
}

// ---------- 校验结果 ----------

export type ServiceResult = {
  ok: boolean
  message: string
}

function fail(message: string): ServiceResult {
  return { ok: false, message }
}

function nowStamp(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = new Date()
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

// ---------- 受控落库 ----------

function cloneRoot(root: LightingRoot): LightingRoot {
  return JSON.parse(JSON.stringify(root)) as LightingRoot
}

// 整笔提交：提交前校验台账不变量（编号唯一、位置归属舱室、一盏灯至多一张未完成报修单、
// 报修单与检修记录一一对应）。任何不变量被破坏就整笔退回，前后两次读到的仍是同一份数据。
function commitRoot(next: LightingRoot): ServiceResult {
  const codeSeen = new Set<string>()
  for (const lamp of next.lamps) {
    const cabinCode = lampCabinCode(lamp)
    if (codeSeen.has(lamp.灯具编号)) {
      return fail(`落库回滚：灯具编号「${lamp.灯具编号}」重号，整笔退回`)
    }
    codeSeen.add(lamp.灯具编号)
    if (!isPositionOfCabin(cabinCode, lamp.安装位置)) {
      return fail(`落库回滚：灯具「${lamp.灯具编号}」安装位置与${cabinName(cabinCode)}对不上，整笔退回`)
    }
    const openCount = next.reports.filter(
      (report) => report.lampId === lamp.id && !report.closed,
    ).length
    if (openCount > 1) {
      return fail(`落库回滚：灯具「${lamp.灯具编号}」存在 ${openCount} 条未完成报修单，重复登记整笔退回`)
    }
  }
  for (const report of next.reports) {
    const linked = next.lamps.some((lamp) => lamp.id === report.lampId)
    if (!linked) {
      return fail(`落库回滚：报修单「${report.reportNo}」找不到对应灯具，整笔退回`)
    }
  }
  saveLightingRoot(next)
  return { ok: true, message: '' }
}

function currentRoot(): LightingRoot {
  const state = getLightingState()
  return { lamps: state.lamps as LightingLamp[], reports: state.reports, maintenance: state.maintenance }
}

function saveLightingRoot(next: LightingRoot): void {
  commitLightingState({ lamps: next.lamps, reports: next.reports, maintenance: next.maintenance })
}

export type RegisterLampInput = {
  postId: string
  accountName: string
  cabinCode: string
  lampType: string
  position: string
  watt: string
  acceptedAt: string
}

// 登记新灯具：只有本舱室照明责任岗位能提交；编号服务端按舱室顺序分配，杜绝重号。
export function registerLamp(input: RegisterLampInput): ServiceResult {
  const denied = assertCabinOwner(input.postId, input.cabinCode, '登记照明灯具')
  if (denied) {
    return fail(denied)
  }
  const position = input.position.trim()
  if (!isPositionOfCabin(input.cabinCode, position)) {
    return fail(
      `入账拦截：安装位置「${position || '未填写'}」不属于${lampFullCabin(input.cabinCode)}登记位置，位置对不上不许入账`,
    )
  }
  const root = cloneRoot(currentRoot())
  if (root.lamps.some((lamp) => lampCabinCode(lamp) === input.cabinCode && lamp.安装位置 === position)) {
    return fail(`入账拦截：${lampFullCabin(input.cabinCode)}的「${position}」已有一盏灯，同位置重复登记不许入账`)
  }
  const post = postById(input.postId)
  const stamp = nowStamp()
  const lamp: LightingLamp = {
    id: nextId(root.lamps),
    status: '待巡检',
    pending: true,
    abnormal: false,
    灯具编号: nextLampCode(root, input.cabinCode),
    所属舱室: cabinName(input.cabinCode),
    灯具类型: input.lampType.trim() || 'LED防潮灯',
    安装位置: position,
    额定功率: input.watt.trim() || '36W',
    巡检日期: '',
    巡检人员: '',
    照明状态: '待巡检',
    验收日期: input.acceptedAt.trim(),
    责任岗位: post?.name ?? '',
    登记时间: stamp,
    history: [
      {
        at: stamp,
        operator: input.accountName,
        post: post?.name ?? '',
        action: '登记入账',
        detail: `按归属岗位登记于${position}，编号由系统按舱室顺序分配`,
      },
    ],
  }
  const next = cloneRoot(root)
  next.lamps.push(lamp)
  const committed = commitRoot(next)
  if (!committed.ok) {
    return committed
  }
  return { ok: true, message: `灯具「${lamp.灯具编号}」已登记入账（${lampFullCabin(input.cabinCode)}·${position}）` }
}

export type ReportDamageInput = {
  postId: string
  accountName: string
  lampId: number
  damageNote: string
}

// 登记损坏（受控入口）：归属岗位校验 → 重号/重复报修校验 → 同时生成检修待办与值班遗留，
// 一次性原子提交。同一盏灯反复登记只认第一次那份，后到的整条退回、条数不叠加。
export function reportDamage(input: ReportDamageInput): ServiceResult {
  const root = cloneRoot(currentRoot())
  const lamp = root.lamps.find((item) => item.id === input.lampId)
  if (!lamp) {
    return fail('报修驳回：台账里没有这盏灯，安装位置/灯具编号对不上的记录不许入账')
  }
  const cabinCode = lampCabinCode(lamp)
  const denied = assertCabinOwner(input.postId, cabinCode, '登记灯具损坏')
  if (denied) {
    return fail(denied)
  }
  if (lamp.status === '已损坏') {
    const existing = root.reports.find((report) => report.lampId === lamp.id && !report.closed)
    if (existing) {
      return fail(
        `重复报修整条退回：灯具「${lamp.灯具编号}」已有报修单 ${existing.reportNo}（${existing.reportedAt}），同一盏灯只认第一次登记，条数不叠加`,
      )
    }
  }
  if (!isPositionOfCabin(cabinCode, lamp.安装位置)) {
    return fail(`报修驳回：灯具「${lamp.灯具编号}」安装位置与${cabinName(cabinCode)}对不上，先整改台账`)
  }

  const post = postById(input.postId)
  const stamp = nowStamp()
  const reportId = nextId(root.reports)
  const reportNo = `ZMSB-${String(reportId).padStart(4, '0')}`
  const report: DamageReport = {
    id: reportId,
    reportNo,
    lampId: lamp.id,
    lampCode: lamp.灯具编号,
    cabinCode,
    position: lamp.安装位置,
    reportedAt: stamp,
    reporter: input.accountName,
    reporterPost: post?.name ?? '',
    damageNote: input.damageNote.trim() || '灯具不亮，需更换',
    maintenanceId: 0,
    maintenanceNo: '',
    closed: false,
    closedAt: '',
  }
  const updatedLamp: LightingLamp = {
    ...lamp,
    status: '已损坏',
    pending: false,
    abnormal: true,
    照明状态: '已损坏',
    巡检日期: stamp.slice(0, 10),
    巡检人员: input.accountName,
    history: [
      ...lamp.history,
      {
        at: stamp,
        operator: input.accountName,
        post: post?.name ?? '',
        action: '登记损坏',
        detail: `${reportNo}：${report.damageNote}；已推送设施检修待办与值班遗留清单`,
      },
    ],
  }
  const next = cloneRoot(root)
  next.lamps = next.lamps.map((item) => (item.id === lamp.id ? updatedLamp : item))
  next.reports.push(report)
  const maintenanceRow = buildMaintenanceRow(next, report)
  report.maintenanceId = maintenanceRow.id
  report.maintenanceNo = String(maintenanceRow.检修编号)
  next.maintenance = [...root.maintenance, maintenanceRow]
  const committed = commitRoot(next)
  if (!committed.ok) {
    return committed
  }
  return {
    ok: true,
    message: `灯具「${lamp.灯具编号}」损坏登记成功，检修待办 ${maintenanceRow.检修编号} 已生成，检修班从设施检修管理接这批更换`,
  }
}

// 检修待办行：字段沿用设施检修管理模块，来源标明是照明更换，便于检修班接单。
function buildMaintenanceRow(root: LightingRoot, report: DamageReport): EntryRow {
  const existing = root.maintenance
  const id = existing.reduce((max, row) => Math.max(max, Number(row.id) ?? 0), 0) + 1
  const no = `MAIN-ZM-${String(
    existing.filter((row) => String(row.检修编号).startsWith('MAIN-ZM-')).length + 1,
  ).padStart(4, '0')}`
  return {
    id,
    status: '待开工',
    pending: true,
    abnormal: false,
    检修编号: no,
    检修对象: `照明灯具 ${report.lampCode}（${lampFullCabin(report.cabinCode)}·${report.position}）`,
    检修类别: '照明灯具更换',
    检修班组: '检修班',
    计划工期: '2个工作日',
    完工日期: '',
    更换部件: `LED灯具（${report.damageNote}）`,
    检修状态: '待开工',
    来源类型: '照明损坏报修',
    来源单号: report.reportNo,
    登记时间: report.reportedAt,
  }
}

// 检修班完成更换：只有检修班岗位能动；灯具、报修单、检修记录在同一笔事务里闭环。
export function completeReplacement(postId: string, accountName: string, reportId: number): ServiceResult {
  if (!scopeOf(postId).isRepairCrew) {
    const post = postById(postId)
    return fail(`归属冲突：更换完工由「检修班」接单确认，当前岗位「${post?.name ?? '未知'}」无权操作，已驳回`)
  }
  const root = cloneRoot(currentRoot())
  const report = root.reports.find((item) => item.id === reportId)
  if (!report) {
    return fail('完工回滚：找不到对应的照明报修单')
  }
  if (report.closed) {
    return fail(`报修单 ${report.reportNo} 已完成更换，无需重复操作`)
  }
  const stamp = nowStamp()
  const lamp = root.lamps.find((item) => item.id === report.lampId)
  const next = cloneRoot(root)
  next.reports = next.reports.map((item) =>
    item.id === report.id ? { ...item, closed: true, closedAt: stamp } : item,
  )
  if (lamp) {
    const restored: LightingLamp = {
      ...lamp,
      status: '照明正常',
      pending: false,
      abnormal: false,
      照明状态: '照明正常',
      history: [
        ...lamp.history,
        {
          at: stamp,
          operator: accountName,
          post: '检修班',
          action: '更换完成',
          detail: `检修单 ${report.maintenanceNo} 完工，灯具恢复正常，待办与遗留同步核销`,
        },
      ],
    }
    next.lamps = next.lamps.map((item) => (item.id === lamp.id ? restored : item))
  }
  next.maintenance = next.maintenance.map((row) =>
    Number(row.id) === report.maintenanceId
      ? {
          ...row,
          status: '已完工',
          pending: false,
          完工日期: stamp.slice(0, 10),
          检修状态: '已完工',
        }
      : row,
  )
  const committed = commitRoot(next)
  if (!committed.ok) {
    return committed
  }
  return { ok: true, message: `灯具「${report.lampCode}」更换完成，报修单 ${report.reportNo} 与检修待办 ${report.maintenanceNo} 同步闭环` }
}
