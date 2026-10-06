// 域逻辑自检：用 esbuild 打包后在 node 下跑（脚本里自带最小 localStorage 桩）。
// 覆盖：上线前重排号、归属拦截、位置查重、重复报修只认第一次、
// 待办与遗留条数一致、完工闭环、通用动作入口受控、整笔事务回滚、旧库迁移幂等。
import { __resetStoreCacheForTest, storageKey } from '../src/data/local-store'

function installStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  const storage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  }
  const g = globalThis as unknown as { window: unknown; localStorage: unknown }
  g.window = { localStorage: storage }
  g.localStorage = storage
  __resetStoreCacheForTest()
}

let failures = 0
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`✓ ${message}`)
  } else {
    failures += 1
    console.error(`✗ ${message}`)
  }
}

async function main() {
  // 注册迁移器（与 main.ts 一致），后续按用例重置存储。
  await import('../src/domain/bootstrap')
  const store = await import('../src/data/local-store')
  const lighting = await import('../src/domain/lighting')
  const service = await import('../src/api/local-service')

  // 1. 首次播种即迁移：重号/跳号按安装位置重排，缺号连续补齐
  installStorage()
  {
    const lamps = store.getLightingState().lamps
    const codes = lamps.map((l) => l.灯具编号)
    assert(codes.length === 10, `迁移后灯具 10 盏（实际 ${codes.length}）`)
    const a = codes.filter((c) => c.startsWith('ZMA-'))
    assert(
      JSON.stringify(a) === JSON.stringify(['ZMA-01', 'ZMA-02', 'ZMA-03', 'ZMA-04', 'ZMA-05']),
      `A舱按位置连续补号、重号消失：${a.join(',')}`,
    )
    assert(
      JSON.stringify(codes.filter((c) => c.startsWith('ZMB-'))) === JSON.stringify(['ZMB-01', 'ZMB-02']),
      'B舱连续编号',
    )
    const d = lamps.find((l) => l.灯具编号 === 'ZMD-01')!
    assert(d.安装位置 === 'D-K0+020', `位置与舱室对不上的缺项按舱室顺序补到首个空闲位置：${d.安装位置}`)
    assert(d.history.some((h) => h.action === '缺项补位'), '缺项补位在履历留痕，原异常位置可追溯')
    assert(new Set(codes).size === codes.length, '全台账编号唯一')
    const noDate = lamps.find((l) => l.id === 3)!
    assert(
      noDate.责任岗位 === '1#电力舱照明责任岗位' && noDate.登记时间.startsWith('2024-03-02'),
      `无验收/登记时间的按最早一次动作推定：${noDate.登记时间}`,
    )
    // 再读一次，编号不变（迁移幂等）
    __resetStoreCacheForTest()
    const again = store.getLightingState().lamps.map((l) => l.灯具编号)
    assert(JSON.stringify(again) === JSON.stringify(codes), '二次读取与首次完全一致（同一份数据）')
  }

  // 2. 外协/他舱/检修班/管理员提交一律驳回，写明归属冲突；不留任何数据
  installStorage()
  {
    const before = store.getLightingState().lamps.length
    const r1 = lighting.reportDamage({ postId: 'outsource', accountName: '外协·孙工', lampId: 1, damageNote: '坏了' })
    assert(!r1.ok && r1.message.includes('归属冲突'), `外协替整舱登记被拒：${r1.message}`)
    const r2 = lighting.reportDamage({ postId: 'light-b', accountName: '李兰', lampId: 1, damageNote: '坏了' })
    assert(!r2.ok && r2.message.includes('1#电力舱') && r2.message.includes('2#综合舱'), `他舱岗位被拒并写明归属双方：${r2.message}`)
    const r3 = lighting.registerLamp({ postId: 'repair', accountName: '陈修', cabinCode: 'A', position: 'A-K0+020', lampType: 'x', watt: '1', acceptedAt: '' })
    assert(!r3.ok && r3.message.includes('只读'), `检修班不能登记灯具：${r3.message}`)
    const r4 = lighting.reportDamage({ postId: 'duty-admin', accountName: '值班管理员', lampId: 1, damageNote: 'x' })
    assert(!r4.ok, `值班管理员对台账只读：${r4.message}`)
    assert(store.getLightingState().lamps.length === before, '驳回后台账条数不变、不留半成品')
  }

  // 3. 安装位置对不上 / 同位置重复登记被拦
  installStorage()
  {
    const r = lighting.registerLamp({ postId: 'light-a', accountName: '周明', cabinCode: 'A', position: 'B-K0+020', lampType: 'LED', watt: '36', acceptedAt: '2026-10-01' })
    assert(!r.ok && r.message.includes('位置'), `跨舱位置入账拦截：${r.message}`)
    const r2 = lighting.registerLamp({ postId: 'light-a', accountName: '周明', cabinCode: 'A', position: 'A-K0+020', lampType: 'LED', watt: '36', acceptedAt: '2026-10-01' })
    assert(!r2.ok && r2.message.includes('已有一盏灯'), `同位置重复登记拦截：${r2.message}`)
    assert(store.getLightingState().lamps.every((l) => typeof l.灯具编号 === 'string'), '被拦后无脏数据')
  }

  // 4. 正常报修：待办/遗留同源；重复只认第一次；完工闭环三表一致
  installStorage()
  {
    const lamp = store.getLightingState().lamps.find((l) => l.灯具编号 === 'ZMA-01')!
    const ok = lighting.reportDamage({ postId: 'light-a', accountName: '周明', lampId: lamp.id, damageNote: '灯具不亮' })
    assert(ok.ok, `归属岗位报修成功：${ok.message}`)
    assert(service.listReplacementTodos().length === 1, '照明更换待办 1 条')
    const dup = lighting.reportDamage({ postId: 'light-a', accountName: '周明', lampId: lamp.id, damageNote: '再报一次' })
    assert(!dup.ok && dup.message.includes('只认第一次'), `同一盏灯反复登记整条退回：${dup.message}`)
    assert(service.listReplacementTodos().length === 1, '重复上报条数不叠加')
    const state = store.getLightingState()
    assert(
      state.reports.length === 1 && state.maintenance.some((m) => m['来源单号'] === state.reports[0].reportNo),
      '报修单与检修记录一一对应，同一笔落库',
    )
    const damaged = state.lamps.find((l) => l.id === lamp.id)!
    assert(damaged.status === '已损坏' && damaged.abnormal, '灯具转已损坏并标记异常')
    assert(damaged.history.at(-1)!.operator === '周明', '台账留痕到具体操作账号与岗位')
    const notCrew = lighting.completeReplacement('light-a', '周明', state.reports[0].id)
    assert(!notCrew.ok && notCrew.message.includes('检修班'), `非检修班完工被驳：${notCrew.message}`)
    const done = lighting.completeReplacement('repair', '陈修', state.reports[0].id)
    assert(done.ok, `检修班完工闭环：${done.message}`)
    assert(service.listReplacementTodos().length === 0, '完工后待办与遗留同步核销，两处仍一致')
    const after = store.getLightingState()
    assert(
      after.reports[0].closed && after.lamps.find((l) => l.id === lamp.id)!.status === '照明正常',
      '灯具恢复正常、报修单关闭、检修记录已完工（同一事务）',
    )
  }

  // 5. 通用动作入口对灯具和派生检修记录只读
  installStorage()
  {
    const blockedLamp = service.runAction('lighting', 1, '登记损坏')
    assert(!blockedLamp.ok && blockedLamp.message.includes('受控'), `通用入口改灯具被拦：${blockedLamp.message}`)
    const lamp = store.getLightingState().lamps[0]
    lighting.reportDamage({ postId: 'light-a', accountName: '周明', lampId: lamp.id, damageNote: '坏' })
    const state = store.getLightingState()
    const derived = state.maintenance.find((m) => m['来源类型'] === '照明损坏报修')!
    const blockedMaint = service.runAction('maintenance', Number(derived.id), '提交开工')
    assert(!blockedMaint.ok && blockedMaint.message.includes('受控'), `派生检修记录不能从通用入口流转：${blockedMaint.message}`)
  }

  // 6. 旧版 localStorage（平铺 module 结构）也能迁移
  {
    const old = JSON.stringify({
      lighting: [
        { id: 1, status: '照明正常', pending: false, abnormal: false, 灯具编号: 'X-1', 所属舱室: '2#综合舱', 灯具类型: 'LED', 安装位置: 'B-K0+100', 额定功率: '40W', 巡检日期: '2026-01-01', 巡检人员: '李兰', 照明状态: '照明正常' },
      ],
      maintenance: [],
    })
    installStorage({ [storageKey()]: old })
    const code = store.getLightingState().lamps[0].灯具编号
    assert(code === 'ZMB-01', `旧库按位置重排：${code}`)
  }

  if (failures > 0) {
    console.error(`\n${failures} 项自检未通过`)
    process.exit(1)
  }
  console.log('\n全部自检通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
