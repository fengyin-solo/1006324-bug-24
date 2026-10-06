/* 照明台账规则验证脚本：esbuild 打包后用 node 跑，localStorage 用内存桩。 */

// Node 环境下的 localStorage 内存桩，行为与浏览器一致（按 key 持久化）。
const memory = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
}
;(globalThis as Record<string, unknown>).localStorage = (globalThis as { window: { localStorage: Storage } }).window.localStorage

import { accountOf } from '../src/data/access'
import {
  ensureLedger,
  lightingBoard,
  lampDetail,
  registerDamageBatch,
  registerLamp,
  resetLedger,
  setClock,
  processReplacement,
} from '../src/api/lighting-ledger'
import { listRows } from '../src/data/local-store'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) {
    pass += 1
    console.log(`  ✔ ${label}`)
  } else {
    fail += 1
    console.error(`  �“✘ ${label}`)
  }
}

const zhou = accountOf('zhou')   // 外包
const zhangw = accountOf('zhangw') // 综合舱岗
const lina = accountOf('lina')   // 电力舱岗
const wangq = accountOf('wangq') // 燃气舱岗
const zhaom = accountOf('zhaom') // 水信舱岗
const sun = accountOf('sun')     // 检修班
const chen = accountOf('chen')   // 管理员

setClock('2026-10-06 14:00')

console.log('\n== 1. 上线归置 ==')
ensureLedger()
const board1 = lightingBoard()
assert(board1.total === 14, `在册 14 盏（实际 ${board1.total}）`)
assert(board1.rejected === 3, `退回 3 条：重号/位置不符/同位置重复（实际 ${board1.rejected}）`)
assert(board1.damaged === 2, `早年损坏 2 盏（实际 ${board1.damaged}）`)
assert(board1.openMaintenance === 2, `检修待办 2 条与损坏数一致（实际 ${board1.openMaintenance}）`)
const codes = board1.lamps.map((l) => String(l.灯具编号))
assert(codes.includes('ZM-ZH-001') && codes.includes('ZM-ZH-005'), '综合舱按位置连号 ZM-ZH-001..005')
assert(codes.includes('ZM-DL-001') && codes.includes('ZM-DL-004'), '电力舱连号 ZM-DL-001..004')
assert(codes.includes('ZM-RQ-001') && codes.includes('ZM-RQ-002'), '燃气舱连号 ZM-RQ-001..002')
assert(codes.includes('ZM-SX-001') && codes.includes('ZM-SX-003'), '水信舱连号 ZM-SX-001..003')
// 无重号
assert(new Set(codes).size === codes.length, '全部灯具编号无重号')
// 顺序：舱室顺序 + 位置顺序
const cabins = board1.lamps.map((l) => String(l.所属舱室))
assert(cabins.join() === ['综合舱', '综合舱', '综合舱', '综合舱', '综合舱', '电力舱', '电力舱', '电力舱', '电力舱', '燃气舱', '燃气舱', '水信舱', '水信舱', '水信舱'].join(), '按舱室固定顺序归位')
// 缺登记时间推定
const lampNoDate = lampDetail('ZM-ZH-004')
assert(!!lampNoDate && lampNoDate.lamp.登记时间 === '2026-03-11 15:20', '无验收日期按最早动作推定（ZM-ZH-004 = 2026-03-11 15:20）')
const lampNoDate2 = lampDetail('ZM-ZH-005')
assert(!!lampNoDate2 && lampNoDate2.lamp.登记时间 === '2026-03-18 10:05', '外包代登记无验收日期按该次动作推定（ZM-ZH-005）')
// 验收日期归位
const lampDate = lampDetail('ZM-ZH-001')
assert(!!lampDate && lampDate.lamp.登记时间 === '2026-03-04 00:00', '有验收日期按验收日期归位')
// 重号只留最早
const rejectedCodes = board1.quarantined.map((q) => q.rawCode)
assert(rejectedCodes.includes('LIGH-0102'), '重号 LIGH-0102 后到一份被退回')
assert(board1.quarantined.some((q) => q.reason.includes('不属于')), '位置 K0+175 不属于水信舱被退回')
assert(board1.quarantined.some((q) => q.reason.includes('同位置重复')), '电力舱 K0+110 同位置重复后到被退回')
// 原编号保留
assert(!!lampDate && lampDate.lamp.原编号 === 'LIGH-0011', '原编号留档')
// 审计留痕
const auditCount = lampDate!.events.length
assert(auditCount >= 2, `每盏灯有遗留动作+归置审计（实际 ${auditCount}）`)
assert(board1.events.every((e) => e.operator.length > 0), '所有审计都有操作人，台账留得住是谁动的')

console.log('\n== 2. 归属受控：外包/管理员/他舱岗位只读 ==')
const r1 = registerDamageBatch(zhou, [{ lampCode: 'ZM-ZH-001', description: 'x' }])
assert(!r1.ok && r1.message.includes('归属冲突') && r1.message.includes('不是照明责任岗'), '外包账号整笔拒绝，写明归属冲突')
const r2 = registerDamageBatch(chen, [{ lampCode: 'ZM-ZH-001', description: 'x' }])
assert(!r2.ok && r2.message.includes('归属冲突'), '值班管理员也不能登记')
const r3 = registerDamageBatch(lina, [{ lampCode: 'ZM-ZH-002', description: 'x' }])
assert(!r3.ok && r3.message.includes('归属冲突') && r3.message.includes('综合舱'), '电力舱岗动综合舱灯具：归属冲突驳回')
const r4 = registerLamp(zhou, { cabin: '综合舱', lampType: 'x', position: 'K0+020', power: '', acceptedDate: '' })
assert(!r4.ok, '外包补录同样驳回')
// 拒绝后条数不叠加
const board2 = lightingBoard()
assert(board2.total === 14 && board2.openMaintenance === 2, `越权被拒后台账不变（${board2.total}/待办 ${board2.openMaintenance}）`)
assert(board2.quarantined.length === 4, `越权尝试进遗留清单（3+1=4，实际 ${board2.quarantined.length}）`)

console.log('\n== 3. 本舱岗位登记损坏：事务联动 ==')
const before = lightingBoard()
const ok1 = registerDamageBatch(zhangw, [
  { lampCode: 'ZM-ZH-001', description: '灯具不亮' },
  { lampCode: 'ZM-ZH-004', description: '进水' },
])
assert(ok1.ok, '综合舱岗登记 2 盏成功')
const after = lightingBoard()
assert(after.damaged === 4, `损坏 2→4（实际 ${after.damaged}）`)
assert(after.openMaintenance === 4, `检修待办同步 2→4（实际 ${after.openMaintenance}）`)
assert(after.pendingReplacement === after.openMaintenance, '待更换数与检修待办条数一致')
const maint = listRows('maintenance')
const job1 = maint.find((m) => String(m.检修编号) === 'MAIN-ZM-ZH-001')
assert(!!job1 && job1.检修类别 === '灯具更换' && job1.检修班组 === '照明检修班', '待办落到设施检修管理，检修班承接')
const detail1 = lampDetail('ZM-ZH-001')
assert(!!detail1 && detail1.events.some((e) => e.action === '登记损坏' && e.operator === '张伟' && e.detail === '灯具不亮'), '损坏登记审计带操作人与说明')

console.log('\n== 4. 重复登记只认第一次，后到整条退回，条数不叠加 ==')
const dup = registerDamageBatch(zhangw, [{ lampCode: 'ZM-ZH-001', description: '再报一次' }])
assert(!dup.ok && dup.message.includes('重复录入只认第一次'), '同一盏灯重复损坏登记整条退回')
const board3 = lightingBoard()
assert(board3.damaged === 4 && board3.openMaintenance === 4, `重复未叠加（损坏 ${board3.damaged}/待办 ${board3.openMaintenance}）`)
assert(board3.quarantined.length === 5, `重复进遗留清单 4→5（实际 ${board3.quarantined.length}）`)

console.log('\n== 5. 整笔退回：一笔里夹一个越权/重复，全部不落 ==')
const mixed = registerDamageBatch(zhangw, [
  { lampCode: 'ZM-ZH-002', description: '本舱合法' },
  { lampCode: 'ZM-DL-001', description: '越舱非法' },
])
assert(!mixed.ok && mixed.message.includes('整笔退回'), '混合批次整笔退回')
const board4 = lightingBoard()
assert(board4.damaged === 4, `整笔退回时合法的那盏也没落库（损坏仍 ${board4.damaged}）`)
assert(board4.openMaintenance === 4, `检修待办不增加（仍 ${board4.openMaintenance}）`)

console.log('\n== 6. 编号/位置拦截（补录） ==')
const badPos = registerLamp(zhangw, { cabin: '综合舱', lampType: 'LED', position: 'K9+999', power: '36W', acceptedDate: '' })
assert(!badPos.ok && badPos.message.includes('位置目录'), '位置对不上目录不许入账')
const occupied = registerLamp(zhangw, { cabin: '综合舱', lampType: 'LED', position: 'K0+020', power: '36W', acceptedDate: '' })
assert(!occupied.ok && occupied.message.includes('已有一盏'), '位置已占用不许入账')
const otherCabin = registerLamp(zhangw, { cabin: '燃气舱', lampType: 'LED', position: 'K0+120', power: '30W', acceptedDate: '' })
assert(!otherCabin.ok && otherCabin.message.includes('归属冲突'), '补录他舱位置也被归属拦截')
// 合法补录：综合舱 001..005 已占，取最小空号 006
const okNew = registerLamp(zhangw, { cabin: '综合舱', lampType: 'LED防潮灯', position: 'K0+220', power: '36W', acceptedDate: '2026-10-01' })
assert(okNew.ok && okNew.codes?.[0] === 'ZM-ZH-006', `补录取舱内最小空号 → ZM-ZH-006（实际 ${okNew.codes?.[0]}）`)
const board5 = lightingBoard()
assert(board5.total === 15, `台账 14→15（实际 ${board5.total}）`)
assert(board5.lamps.some((l) => String(l.灯具编号) === 'ZM-ZH-006' && String(l.安装位置) === 'K0+220'), '补录灯具在册')

console.log('\n== 7. 缺号补齐：先在中间腾号再补，应取最小空号 ==')
// 水信舱 001..003 连续，无法腾号；综合舱新补的 006 已占满目录外，改为燃气舱补位 K0+120（目录有、无灯）
const okGap = registerLamp(wangq, { cabin: '燃气舱', lampType: '防爆LED灯', position: 'K0+120', power: '30W', acceptedDate: '' })
assert(okGap.ok && okGap.codes?.[0] === 'ZM-RQ-003', `燃气舱新位连号 → ZM-RQ-003（实际 ${okGap.codes?.[0]}）`)

console.log('\n== 8. 检修班接单：开工/完工双向回写同步 ==')
const crewWrong = processReplacement(zhou, Number(job1!.id), '提交开工')
assert(!crewWrong.ok && crewWrong.message.includes('归属冲突'), '非检修班不能接单')
const open = processReplacement(sun, Number(job1!.id), '提交开工')
assert(open.ok, '检修班开工成功')
const b6 = lightingBoard()
const d6 = lampDetail('ZM-ZH-001')
assert(d6?.lamp.status === '更换中', '灯具状态同步为更换中')
assert(d6?.job?.status === '检修中', '检修待办同步为检修中')
assert(b6.pendingReplacement === b6.openMaintenance, '更换中仍计入待办，两处条数一致')
const finish = processReplacement(sun, Number(job1!.id), '确认完工')
assert(finish.ok, '检修班完工成功')
const b7 = lightingBoard()
const d7 = lampDetail('ZM-ZH-001')
assert(d7?.lamp.status === '照明正常' && !d7.lamp.abnormal, '完工后灯具恢复照明正常')
assert(d7?.job?.status === '已完工', '待办标记已完工')
assert(b7.pendingReplacement === b7.openMaintenance, `完工后两处一致（${b7.pendingReplacement}=${b7.openMaintenance}）`)
const repeatFinish = processReplacement(sun, Number(job1!.id), '确认完工')
assert(!repeatFinish.ok, '重复完工被拒绝')

console.log('\n== 9. 同源一致：列表/详情/遗留/检修入口取同一份 ==')
const b8 = lightingBoard()
const maintBoard = lightingBoard()
assert(b8.rejected === maintBoard.quarantined.length, '照明页与检修页遗留清单条数一致')
assert(b8.openMaintenance === maintBoard.openMaintenance, '两处待办计数一致')
const filtered = lightingBoard({ 所属舱室: '燃气舱' })
assert(filtered.lamps.length === 3, `筛选不改变在册总数口径，燃气舱 3 盏（实际 ${filtered.lamps.length}）`)

console.log('\n== 10. 重置后重新归置，结果自洽 ==')
resetLedger()
const b9 = lightingBoard()
assert(b9.total === 14 && b9.rejected === 3 && b9.damaged === 2 && b9.openMaintenance === 2, '重置归置结果与首次一致（幂等自洽）')
assert(b9.events.every((e) => e.id > 0), '审计重新编号完整')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) {
  process.exit(1)
}
