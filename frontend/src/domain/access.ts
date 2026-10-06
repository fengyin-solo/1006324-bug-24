// 归属与授权域模型：舱室、岗位、账号集中在这里登记。
// 受控入口只认「岗位 + 归属舱室」，页面上的按钮和服务里的落库都以这里为唯一依据。

export type PostRole = '照明责任岗位' | '检修班' | '外协人员' | '值班管理员'

export type Post = {
  id: string
  name: string
  role: PostRole
  // 只有照明责任岗位带归属舱室；其余岗位没有舱室归属，对灯具台账只读。
  cabinCode?: string
}

export type Account = {
  id: string
  name: string
  postId: string
}

export type Cabin = {
  code: string
  name: string
  // 该舱室内允许登记灯具的安装位置（与舱室一一对应，跨舱室位置一律视为对不上）。
  positions: string[]
}

export const CABINS: Cabin[] = [
  {
    code: 'A',
    name: '1#电力舱',
    positions: ['A-K0+020', 'A-K0+040', 'A-K0+060', 'A-K0+080', 'A-K0+100', 'A-K0+120'],
  },
  {
    code: 'B',
    name: '2#综合舱',
    positions: ['B-K0+020', 'B-K0+040', 'B-K0+060', 'B-K0+080', 'B-K0+100', 'B-K0+120'],
  },
  {
    code: 'C',
    name: '3#燃气舱',
    positions: ['C-K0+020', 'C-K0+040', 'C-K0+060', 'C-K0+080', 'C-K0+100'],
  },
  {
    code: 'D',
    name: '4#污水舱',
    positions: ['D-K0+020', 'D-K0+040', 'D-K0+060', 'D-K0+080'],
  },
]

export const POSTS: Post[] = [
  { id: 'light-a', name: '1#电力舱照明责任岗位', role: '照明责任岗位', cabinCode: 'A' },
  { id: 'light-b', name: '2#综合舱照明责任岗位', role: '照明责任岗位', cabinCode: 'B' },
  { id: 'light-c', name: '3#燃气舱照明责任岗位', role: '照明责任岗位', cabinCode: 'C' },
  { id: 'light-d', name: '4#污水舱照明责任岗位', role: '照明责任岗位', cabinCode: 'D' },
  { id: 'repair', name: '检修班', role: '检修班' },
  { id: 'outsource', name: '外协人员', role: '外协人员' },
  { id: 'duty-admin', name: '值班管理员', role: '值班管理员' },
]

export const ACCOUNTS: Account[] = [
  { id: 'u-light-a', name: '周明（电力舱照明岗）', postId: 'light-a' },
  { id: 'u-light-b', name: '李兰（综合舱照明岗）', postId: 'light-b' },
  { id: 'u-light-c', name: '王燃（燃气舱照明岗）', postId: 'light-c' },
  { id: 'u-light-d', name: '赵水（污水舱照明岗）', postId: 'light-d' },
  { id: 'u-repair', name: '陈修（检修班）', postId: 'repair' },
  { id: 'u-outsource', name: '外协·孙工', postId: 'outsource' },
  { id: 'u-admin', name: '值班管理员', postId: 'duty-admin' },
]

export const DEFAULT_ACCOUNT_ID = 'u-admin'

export function cabinByCode(code: string): Cabin | undefined {
  return CABINS.find((cabin) => cabin.code === code)
}

export function cabinName(code: string): string {
  return cabinByCode(code)?.name ?? code
}

export function cabinCodeByName(name: string): string | undefined {
  return CABINS.find((cabin) => cabin.name === name)?.code
}

export function postById(postId: string): Post | undefined {
  return POSTS.find((post) => post.id === postId)
}

export function accountById(accountId: string): Account | undefined {
  return ACCOUNTS.find((account) => account.id === accountId)
}

// 安装位置是否登记在指定舱室名下；位置不在舱室台账里即「安装位置对不上」。
export function isPositionOfCabin(cabinCode: string, position: string): boolean {
  return cabinByCode(cabinCode)?.positions.includes(position) ?? false
}

export type CabinScope = {
  // 归属舱室编码；为空表示该账号不是任何舱室的照明责任岗位。
  cabinCode?: string
  role: PostRole
  isLightingOwner: boolean
  isRepairCrew: boolean
  // 是否能改动灯具台账（登记灯具 / 登记损坏）：只有本舱室的照明责任岗位可以。
  canMutateLighting: boolean
}

export function scopeOf(postId: string): CabinScope {
  const post = postById(postId)
  const role: PostRole = post?.role ?? '值班管理员'
  const isLightingOwner = role === '照明责任岗位' && !!post?.cabinCode
  return {
    cabinCode: post?.cabinCode,
    role,
    isLightingOwner,
    isRepairCrew: role === '检修班',
    canMutateLighting: isLightingOwner,
  }
}

// 归属校验：灯具属于 cabinCode，只有该舱室的照明责任岗位账号才允许提交。
// 越权一律拒绝，消息里写明归属冲突，授权范围之外的账号改不了这类记录。
export function assertCabinOwner(postId: string, cabinCode: string, actionLabel: string): string | null {
  const post = postById(postId)
  if (!post) {
    return `归属冲突：账号未关联有效岗位，无权${actionLabel}`
  }
  if (post.role !== '照明责任岗位' || !post.cabinCode) {
    return `归属冲突：「${post.name}」不属于任何舱室的照明责任岗位，对灯具台账只读，${actionLabel}已驳回`
  }
  if (post.cabinCode !== cabinCode) {
    return (
      `归属冲突：灯具归属于${cabinName(cabinCode)}（${cabinCode}舱），` +
      `当前岗位「${post.name}」只负责${cabinName(post.cabinCode)}（${post.cabinCode}舱），${actionLabel}已驳回`
    )
  }
  return null
}
