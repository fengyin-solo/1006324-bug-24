<template>
  <section class="page" data-module="lighting">
    <header class="page-head">
      <div>
        <h2>廊内照明运维管理（受控台账）</h2>
        <p class="page-desc">照明登记按岗位与归属开放：只有本舱室照明责任岗能登记损坏/补录，别的岗位只读；编号重号、位置对不上、重复登记一律拦截，整笔事务落库。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openDamage">登记灯具损坏</button>
        <button class="btn" type="button" @click="openCreate">补录灯具</button>
        <button class="btn" type="button" @click="toggleReport = !toggleReport">
          {{ toggleReport ? '收起归置报告' : '查看上线归置报告' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card"><span class="stat-label">在册灯具（台账总数）</span><strong class="stat-value">{{ board.total }}</strong></article>
      <article class="stat-card"><span class="stat-label">已损坏待更换</span><strong class="stat-value">{{ board.damaged }}</strong></article>
      <article class="stat-card"><span class="stat-label">更换中</span><strong class="stat-value">{{ board.replacing }}</strong></article>
      <article class="stat-card"><span class="stat-label">检修待办（设施检修管理同步）</span><strong class="stat-value">{{ board.openMaintenance }}</strong></article>
      <article class="stat-card warn"><span class="stat-label">遗留退回清单</span><strong class="stat-value">{{ board.rejected }}</strong></article>
    </div>

    <p class="access-banner" :class="{ deny: !isOwner }">
      当前账号：{{ account.name }}（{{ account.roleLabel }}）· {{ isOwner ? `可登记归属舱室：${account.cabins.join('、')}` : '照明台账只读，归属之外的提交一律驳回' }}
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>详情</th>
          <th>可执行动作（受控）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td><button class="link" type="button" @click="openDetail(String(row.灯具编号))">查看详情</button></td>
          <td class="row-actions">
            <template v-if="canWrite(String(row.所属舱室))">
              <button
                v-for="action in availableActions(row.status)"
                :key="action"
                class="link"
                type="button"
                @click="doAction(action, String(row.灯具编号))"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="readonly-tag">只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">没有符合条件的照明灯具</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>列表共 {{ rows.length }} 条 · 台账在册 {{ board.total }} 盏 · 待更换同步待办 {{ board.pendingReplacement === board.openMaintenance ? `${board.openMaintenance} 条（两处一致）` : `${board.openMaintenance} 条（不一致！）` }}</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <section class="legacy-panel">
      <header class="legacy-head">
        <h3>遗留退回清单（其余入口同步可查）</h3>
        <span>共 {{ board.quarantined.length }} 条，与设施检修管理入口的遗留清单同源同数</span>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>原始编号</th><th>所属舱室</th><th>安装位置</th><th>退回原因</th><th>来源</th><th>操作账号</th><th>时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in board.quarantined" :key="item.id">
            <td>{{ item.rawCode }}</td>
            <td>{{ item.cabin || '—' }}</td>
            <td>{{ item.position || '—' }}</td>
            <td class="reject-reason">{{ item.reason }}</td>
            <td>{{ item.source }}</td>
            <td>{{ item.operator }}</td>
            <td>{{ item.time }}</td>
          </tr>
          <tr v-if="!board.quarantined.length">
            <td colspan="7" class="empty-state">暂无退回遗留</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 损坏登记：多选灯具整笔提交 -->
    <div v-if="damageOpen" class="modal-mask" @click.self="damageOpen = false">
      <div class="modal">
        <h3>登记灯具损坏（整笔事务）</h3>
        <p class="modal-tip">账号 {{ account.name }}（{{ account.roleLabel }}）。越权、重号、位置不符、重复登记都会让整笔退回；全部通过后台账与检修待办一次落库。</p>
        <label class="filter-item">
          <span>损坏情况说明</span>
          <input v-model="damageDesc" placeholder="如：灯具不亮 / 灯罩进水" />
        </label>
        <table class="data-table pick-table">
          <thead>
            <tr><th>选择</th><th>灯具编号</th><th>所属舱室</th><th>安装位置</th><th>灯具类型</th><th>归属</th><th>当前状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="lamp in damageCandidates" :key="lamp.灯具编号" :class="{ offscope: !canWrite(String(lamp.所属舱室)) }">
              <td><input type="checkbox" :value="String(lamp.灯具编号)" v-model="damagePicked" /></td>
              <td>{{ lamp.灯具编号 }}</td>
              <td>{{ lamp.所属舱室 }}</td>
              <td>{{ lamp.安装位置 }}</td>
              <td>{{ lamp.灯具类型 }}</td>
              <td>{{ canWrite(String(lamp.所属舱室)) ? '本岗归属' : '归属之外（提交必驳回）' }}</td>
              <td>{{ lamp.status }}</td>
            </tr>
          </tbody>
        </table>
        <footer class="modal-foot">
          <span class="error-text" v-if="!messageOk && message">{{ message }}</span>
          <button class="btn" type="button" @click="damageOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitDamage">整笔提交（{{ damagePicked.length }}）</button>
        </footer>
      </div>
    </div>

    <!-- 补录灯具 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>补录照明灯具</h3>
        <p class="modal-tip">灯具编号由系统按舱内最小空号分配（ZM-舱码-序号），不可手填，杜绝重号。</p>
        <div class="form-grid">
          <label class="filter-item">
            <span>所属舱室</span>
            <select v-model="draft.cabin">
              <option value="">请选择舱室</option>
              <option v-for="cabin in cabinOptions" :key="cabin" :value="cabin">{{ cabin }}</option>
            </select>
          </label>
          <label class="filter-item">
            <span>安装位置</span>
            <select v-model="draft.position" :disabled="!draft.cabin">
              <option value="">请选择位置</option>
              <option v-for="pos in (CABIN_POSITIONS[draft.cabin] ?? [])" :key="pos" :value="pos">{{ pos }}</option>
            </select>
          </label>
          <label class="filter-item">
            <span>灯具类型</span>
            <input v-model="draft.lampType" placeholder="LED防潮灯" />
          </label>
          <label class="filter-item">
            <span>额定功率</span>
            <input v-model="draft.power" placeholder="36W" />
          </label>
          <label class="filter-item">
            <span>验收日期（可空，空则按本次动作推定）</span>
            <input v-model="draft.acceptedDate" type="date" />
          </label>
        </div>
        <footer class="modal-foot">
          <span class="error-text" v-if="!messageOk && message">{{ message }}</span>
          <button class="btn" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交补录</button>
        </footer>
      </div>
    </div>

    <!-- 详情面板 -->
    <aside v-if="detail" class="detail-drawer" @click.self="detail = null">
      <div class="detail-card">
        <header class="detail-head">
          <h3>灯具详情 {{ detail.lamp.灯具编号 }}</h3>
          <button class="link" type="button" @click="detail = null">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt><dd>{{ detail.lamp[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt><dd>{{ detail.lamp.status }}</dd>
        </dl>
        <h4>检修待办</h4>
        <p v-if="detail.job" class="job-line">
          {{ detail.job.检修编号 }} · {{ detail.job.检修对象 }} · 状态「{{ detail.job.status }}」
        </p>
        <p v-else class="job-line muted">暂无更换待办</p>
        <h4>操作审计（谁动的都留底）</h4>
        <ul class="audit-list">
          <li v-for="event in detail.events" :key="event.id">
            <span class="audit-time">{{ event.time }}</span>
            <strong>{{ event.action }}</strong>
            <span>{{ event.operator }}（{{ event.operatorRole }}）</span>
            <em>{{ event.detail }}</em>
          </li>
          <li v-if="!detail.events.length" class="muted">暂无审计记录</li>
        </ul>
      </div>
    </aside>

    <!-- 上线归置报告 -->
    <div v-if="toggleReport && board.report" class="report-panel">
      <header class="legacy-head">
        <h3>上线前照明台账归置报告（{{ board.report.time }}）</h3>
        <span>接纳 {{ board.report.accepted }} 盏 · 退回 {{ board.report.rejected }} 条 · 早年损坏 {{ board.report.damaged }} 盏已同步检修待办</span>
      </header>
      <p class="report-rule">排号规则：{{ board.report.rule }}</p>
      <table class="data-table">
        <thead>
          <tr><th>新编号</th><th>原编号</th><th>舱室</th><th>安装位置</th><th>登记时间</th><th>归位依据</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in board.report.rows" :key="row.code">
            <td>{{ row.code }}</td><td>{{ row.oldCode }}</td><td>{{ row.cabin }}</td><td>{{ row.position }}</td><td>{{ row.registeredAt }}</td><td>{{ row.basis }}</td>
          </tr>
        </tbody>
      </table>
      <h4 v-if="board.report.rejectedItems.length">归置退回（重号/位置不符/重复位置）</h4>
      <ul v-if="board.report.rejectedItems.length" class="reject-list">
        <li v-for="(item, i) in board.report.rejectedItems" :key="i">
          {{ item.rawCode }} · {{ item.cabin }} {{ item.position }} —— {{ item.reason }}
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { moduleMeta } from '@/api/local-service'
import {
  lightingBoard,
  lampDetail,
  registerDamageBatch,
  registerLamp,
  transitionLamp,
  type LightingBoard,
} from '@/api/lighting-ledger'
import { CABIN_ORDER, CABIN_POSITIONS, cabinInScope, isLightingOwner } from '@/data/access'
import { useSessionStore } from '@/stores/session'
import type { LampRow } from '@/data/types'

const meta = moduleMeta('lighting')
const columns = meta.fields
const filterFields = ['灯具编号', '所属舱室', '安装位置', '责任岗位']
const statuses = ['待巡检', '巡检中', '照明正常', '已损坏', '更换中']

const store = useSessionStore()
const account = computed(() => store.account)
const isOwner = computed(() => isLightingOwner(account.value))
const cabinOptions = [...CABIN_ORDER]

const board = ref<LightingBoard>({
  lamps: [], quarantined: [], events: [], report: null,
  total: 0, damaged: 0, replacing: 0, pendingReplacement: 0, openMaintenance: 0, rejected: 0,
})
const rows = computed<LampRow[]>(() => board.value.lamps)
const filters = ref<Record<string, string>>({})
const message = ref('')
const messageOk = ref(true)
const toggleReport = ref(false)
const detail = ref<Awaited<ReturnType<typeof lampDetail>>>(null)

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: board.value.lamps.filter((row) => String(row.status) === status).length })),
)

function flash(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

function canWrite(cabin: string): boolean {
  return cabinInScope(account.value, cabin)
}

function availableActions(status: string): string[] {
  if (status === '已损坏' || status === '更换中') {
    return []
  }
  if (status === '待巡检') {
    return ['提交巡检', '判定正常']
  }
  if (status === '巡检中') {
    return ['判定正常', '登记损坏']
  }
  return []
}

function reload() {
  try {
    board.value = lightingBoard(filters.value)
  } catch (error) {
    flash(error instanceof Error ? error.message : '照明台账读取失败', false)
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function doAction(action: string, code: string) {
  const result = transitionLamp(account.value, code, action)
  flash(result.message, result.ok)
  reload()
}

function openDetail(code: string) {
  detail.value = lampDetail(code)
}

// ---- 损坏登记 ----
const damageOpen = ref(false)
const damagePicked = ref<string[]>([])
const damageDesc = ref('')
const damageCandidates = ref<LampRow[]>([])

function openDamage() {
  message.value = ''
  damagePicked.value = []
  damageDesc.value = ''
  damageCandidates.value = lightingBoard().lamps.filter((lamp) => lamp.status !== '已损坏' && lamp.status !== '更换中')
  damageOpen.value = true
}

function submitDamage() {
  const result = registerDamageBatch(
    account.value,
    damagePicked.value.map((lampCode) => ({ lampCode, description: damageDesc.value })),
  )
  flash(result.message, result.ok)
  if (result.ok) {
    damageOpen.value = false
  }
  reload()
}

// ---- 补录 ----
const createOpen = ref(false)
const draft = reactive({ cabin: '', position: '', lampType: 'LED防潮灯', power: '36W', acceptedDate: '' })

function openCreate() {
  message.value = ''
  draft.cabin = account.value.cabins[0] ?? ''
  draft.position = ''
  draft.lampType = 'LED防潮灯'
  draft.power = '36W'
  draft.acceptedDate = ''
  createOpen.value = true
}

function submitCreate() {
  const result = registerLamp(account.value, { ...draft })
  flash(result.message, result.ok)
  if (result.ok) {
    createOpen.value = false
  }
  reload()
}

onMounted(reload)
</script>
