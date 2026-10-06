/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 照明灯具归置后的台账行：灯具编号上线时按舱室与安装位置重排，禁止人工改写。 */
export type LampRow = EntryRow & {
  灯具编号: string
  所属舱室: string
  灯具类型: string
  安装位置: string
  责任岗位: string
  验收日期: string
  登记时间: string
  原编号: string
  来源检修编号: string
}

/** 谁在什么时候对哪盏灯做了什么，登记入口的每一步都留痕。 */
export type AuditEvent = {
  id: number
  lampCode: string
  cabin: string
  position: string
  action: string
  operator: string
  operatorRole: string
  time: string
  detail: string
}

/** 归置或登记时整条退回的记录：编号重号、位置对不上、重复登记都进这份遗留清单。 */
export type QuarantineItem = {
  id: number
  rawCode: string
  cabin: string
  position: string
  reason: string
  source: string
  operator: string
  time: string
}
