/** 照明受控入口的岗位、账号、舱室归属与安装位置目录。 */

export type RoleId = 'lighting-owner' | 'maintenance-crew' | 'outsource' | 'admin'

export type Account = {
  id: string
  name: string
  role: RoleId
  roleLabel: string
  /** 照明责任岗承担的舱室；其余岗位为空，对照明台账只读。 */
  cabins: string[]
  note: string
}

/** 舱室固定顺序：上线排号、补号、列表归位都以此为准。 */
export const CABIN_ORDER = ['综合舱', '电力舱', '燃气舱', '水信舱'] as const

export const CABIN_CODE: Record<string, string> = {
  综合舱: 'ZH',
  电力舱: 'DL',
  燃气舱: 'RQ',
  水信舱: 'SX',
}

/** 各舱室合法安装位置目录（按廊向里程固定排序），登记位置必须落在所属舱室目录内。 */
export const CABIN_POSITIONS: Record<string, string[]> = {
  综合舱: ['K0+020', 'K0+060', 'K0+100', 'K0+140', 'K0+180', 'K0+220'],
  电力舱: ['K0+030', 'K0+070', 'K0+110', 'K0+150', 'K0+190'],
  燃气舱: ['K0+040', 'K0+080', 'K0+120'],
  水信舱: ['K0+050', 'K0+090', 'K0+130', 'K0+170'],
}

/** 舱室 → 责任岗位姓名（与账号一一对应）。 */
export const CABIN_OWNER: Record<string, string> = {
  综合舱: '张伟',
  电力舱: '李娜',
  燃气舱: '王强',
  水信舱: '赵敏',
}

export const ACCOUNTS: Account[] = [
  { id: 'zhou', name: '周俊', role: 'outsource', roleLabel: '外包检修人员', cabins: [], note: '无照明登记授权，仅可浏览' },
  { id: 'zhangw', name: '张伟', role: 'lighting-owner', roleLabel: '综合舱照明责任岗', cabins: ['综合舱'], note: '仅可登记综合舱灯具' },
  { id: 'lina', name: '李娜', role: 'lighting-owner', roleLabel: '电力舱照明责任岗', cabins: ['电力舱'], note: '仅可登记电力舱灯具' },
  { id: 'wangq', name: '王强', role: 'lighting-owner', roleLabel: '燃气舱照明责任岗', cabins: ['燃气舱'], note: '仅可登记燃气舱灯具' },
  { id: 'zhaom', name: '赵敏', role: 'lighting-owner', roleLabel: '水信舱照明责任岗', cabins: ['水信舱'], note: '仅可登记水信舱灯具' },
  { id: 'sun', name: '孙磊', role: 'maintenance-crew', roleLabel: '照明检修班', cabins: [], note: '从设施检修管理承接灯具更换' },
  { id: 'chen', name: '陈晨', role: 'admin', roleLabel: '值班管理员', cabins: [], note: '全舱只读监督，不留登记权限' },
]

export function accountOf(id: string): Account {
  return ACCOUNTS.find((item) => item.id === id) ?? ACCOUNTS[0]
}

/** 照明责任岗：唯一能提交照明登记的角色。 */
export function isLightingOwner(account: Account): boolean {
  return account.role === 'lighting-owner'
}

/** 受控入口按岗位与归属双重开放：岗位必须是照明责任岗，且舱室在其归属范围内。 */
export function cabinInScope(account: Account, cabin: string): boolean {
  return isLightingOwner(account) && account.cabins.includes(cabin)
}

/** 灯具更换待办只有照明检修班能接。 */
export function canProcessReplacement(account: Account): boolean {
  return account.role === 'maintenance-crew'
}

export function positionIndex(cabin: string, position: string): number {
  return CABIN_POSITIONS[cabin]?.indexOf(position) ?? -1
}
