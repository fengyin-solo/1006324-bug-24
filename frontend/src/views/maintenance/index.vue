<template>
  <section class="page" data-module="maintenance">
    <header class="page-head">
      <div>
        <h2>设施检修管理</h2>
        <p class="page-desc">照明损坏登记的更换任务直接落到这里的待办，照明检修班从本页承接；台账与清单取的是同一份数据。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修记录</button>
        <button class="btn" type="button" @click="exportRows">导出设施检修管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card"><span class="stat-label">全部检修记录</span><strong class="stat-value">{{ total }}</strong></article>
      <article class="stat-card"><span class="stat-label">灯具更换待办（承接照明）</span><strong class="stat-value">{{ lampJobs.length }}</strong></article>
      <article class="stat-card"><span class="stat-label">照明台账待更换</span><strong class="stat-value">{{ board.pendingReplacement }}</strong></article>
      <article class="stat-card warn"><span class="stat-label">照明上报退回遗留</span><strong class="stat-value">{{ board.rejected }}</strong></article>
    </div>

    <p class="access-banner" :class="{ deny: !isCrew }">
      当前账号：{{ account.name }}（{{ account.roleLabel }}）· {{ isCrew ? '可承接灯具更换：开工、完工' : '灯具更换待办只读，只有照明检修班能接单处理' }}
      <template v-if="board.pendingReplacement === lampJobs.length"> · 两处条数一致（{{ lampJobs.length }}）</template>
    </p>

    <h3 class="section-title">照明灯具更换待办（照明台账同步）</h3>
    <table class="data-table">
      <thead>
        <tr><th>检修编号</th><th>检修对象</th><th>检修类别</th><th>检修班组</th><th>计划工期</th><th>完工日期</th><th>当前状态</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="job in lampJobs" :key="String(job.id)">
          <td>{{ job.检修编号 }}</td>
          <td>{{ job.检修对象 }}</td>
          <td>{{ job.检修类别 }}</td>
          <td>{{ job.检修班组 }}</td>
          <td>{{ job.计划工期 }}</td>
          <td>{{ job.完工日期 || '—' }}</td>
          <td>{{ job.status }}</td>
          <td class="row-actions">
            <template v-if="isCrew">
              <button v-if="job.status === '待开工'" class="link" type="button" @click="process(Number(job.id), '提交开工')">提交开工</button>
              <button v-if="job.status !== '已完工'" class="link" type="button" @click="process(Number(job.id), '确认完工')">确认完工</button>
              <span v-else>已完工</span>
            </template>
            <span v-else class="readonly-tag">只读</span>
          </td>
        </tr>
        <tr v-if="!lampJobs.length">
          <td colspan="8" class="empty-state">暂无灯具更换待办</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">全部检修记录</h3>
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设施检修管理数据，可先登记检修记录</td>
        </tr>
      </tbody>
    </table>

    <section class="legacy-panel">
      <header class="legacy-head">
        <h3>照明上报遗留清单（与照明入口同源）</h3>
        <span>共 {{ board.quarantined.length }} 条，与廊内照明运维页的遗留清单条数一致</span>
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

    <footer class="page-foot">
      <span>共 {{ total }} 条检修记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { lightingBoard, processReplacement, type LightingBoard } from '@/api/lighting-ledger'
import { canProcessReplacement } from '@/data/access'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const account = computed(() => store.account)
const isCrew = computed(() => canProcessReplacement(account.value))

const meta = moduleMeta('maintenance')
const columns = ['检修编号', '检修对象', '检修类别', '检修班组', '计划工期', '完工日期', '更换部件', '检修状态']
const actions = ['提交开工', '确认完工', '申请延期']
const statuses = ['待开工', '检修中', '已完工', '已延期']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const board = ref<LightingBoard>({
  lamps: [], quarantined: [], events: [], report: null,
  total: 0, damaged: 0, replacing: 0, pendingReplacement: 0, openMaintenance: 0, rejected: 0,
})
const lampJobs = ref<EntryRow[]>([])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '检修记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function process(jobId: number, action: '提交开工' | '确认完工') {
  const result = processReplacement(account.value, jobId, action)
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    board.value = lightingBoard()
    lampJobs.value = payload.items.filter(
      (row) => String(row.来源灯具编号 ?? '') !== '' && String(row.status) !== '已完工',
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设施检修管理列表读取失败'
  }
}

onMounted(reload)
</script>
