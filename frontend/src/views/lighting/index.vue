<template>
  <section class="page" data-module="lighting">
    <header class="page-head">
      <div>
        <h2>廊内照明运维管理</h2>
        <p class="page-desc">灯具台账按归属舱室受控：只有本舱室照明责任岗位能登记灯具、登记损坏；其余账号只读，越权提交一律驳回并写明归属冲突。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">登记照明灯具</button>
        <button class="btn primary" type="button" @click="openDamage">登记灯具损坏</button>
        <button class="btn" type="button" @click="exportRows">导出廊内照明运维清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="scope-bar" :class="{ readonly: !canMutate }">
      <span>当前账号：{{ store.operator }} · {{ store.postName }}</span>
      <span v-if="canMutate">归属舱室：{{ ownerCabinName }}，仅该舱室灯具可提交</span>
      <span v-else>该岗位不属于任何舱室照明责任岗位，灯具台账只读，提交将被驳回</span>
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

    <div class="split-panels">
      <div class="panel-main">
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in columns" :key="column">{{ column }}</th>
              <th>当前状态</th>
              <th>受控操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="String(row.id)"
              :class="{ selected: selectedId === Number(row.id) }"
              @click="selectRow(Number(row.id))"
            >
              <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
              <td>{{ row.status }}</td>
              <td class="row-actions" @click.stop>
                <button
                  class="link"
                  type="button"
                  :disabled="!canMutate"
                  :title="canMutate ? '为该灯具登记损坏' : '仅本舱室照明责任岗位可登记损坏'"
                  @click="openDamageFor(row)"
                >
                  登记损坏
                </button>
                <button class="link" type="button" @click="selectRow(Number(row.id))">查看详情</button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的照明灯具</td>
            </tr>
          </tbody>
        </table>
        <footer class="page-foot">
          <span>列表共 {{ total }} 条（与右侧详情面板同源，条数一致）</span>
          <span>待更换报修 {{ openTodoCount }} 条，已同步设施检修待办与值班遗留清单</span>
        </footer>
      </div>

      <aside class="panel-detail">
        <h3>灯具详情面板</h3>
        <p class="detail-count">当前列表条数：{{ total }}；选中条目：{{ selected ? 1 : 0 }}</p>
        <template v-if="selected">
          <dl class="detail-grid">
            <template v-for="column in columns" :key="column">
              <dt>{{ column }}</dt>
              <dd>{{ selected[column] || '—' }}</dd>
            </template>
            <dt>当前状态</dt>
            <dd>{{ selected.status }}</dd>
            <dt>登记时间</dt>
            <dd>{{ selected.登记时间 || '—' }}</dd>
          </dl>
          <div class="detail-block">
            <h4>归属与操作履历（留痕）</h4>
            <ul class="audit-list">
              <li v-for="(item, index) in selected.history ?? []" :key="index">
                <span class="audit-at">{{ item.at }}</span>
                <span class="audit-action">{{ item.action }}</span>
                <span class="audit-who">{{ item.operator }} / {{ item.post }}</span>
                <p class="audit-detail">{{ item.detail }}</p>
              </li>
            </ul>
          </div>
          <div class="detail-block">
            <h4>更换/报修记录</h4>
            <ul class="audit-list">
              <li v-for="report in reportsOf(selected.id)" :key="report.reportNo">
                <span class="audit-at">{{ report.reportedAt }}</span>
                <span class="audit-action">{{ report.reportNo }}（检修单 {{ report.maintenanceNo }}）</span>
                <span class="audit-who">{{ report.closed ? '已更换完成' : '待检修班更换' }}</span>
                <p class="audit-detail">{{ report.damageNote }}</p>
              </li>
              <li v-if="!reportsOf(selected.id).length" class="empty-note">该灯具暂无损坏报修记录</li>
            </ul>
          </div>
        </template>
        <p v-else class="empty-note">点击左侧任一条目查看归属、履历与报修记录</p>
      </aside>
    </div>

    <!-- 登记灯具：受控入口，编号由系统按舱室顺序分配 -->
    <div v-if="modal === 'register'" class="modal-mask" @click.self="closeModal">
      <form class="modal-card" @submit.prevent="submitRegister">
        <h3>登记照明灯具</h3>
        <p class="modal-scope">提交岗位：{{ store.operator }} · {{ store.postName }}<template v-if="canMutate">（归属 {{ ownerCabinName }}）</template></p>
        <label class="form-item">
          <span>所属舱室</span>
          <select v-model="registerForm.cabinCode">
            <option v-for="cabin in cabins" :key="cabin.code" :value="cabin.code">{{ cabin.name }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>安装位置</span>
          <select v-model="registerForm.position">
            <option value="" disabled>请选择舱室台账内位置</option>
            <option v-for="position in positionsOf(registerForm.cabinCode)" :key="position" :value="position">{{ position }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>灯具类型</span>
          <input v-model="registerForm.lampType" placeholder="如 LED防潮灯" />
        </label>
        <label class="form-item">
          <span>额定功率</span>
          <input v-model="registerForm.watt" placeholder="如 36W" />
        </label>
        <label class="form-item">
          <span>验收日期</span>
          <input v-model="registerForm.acceptedAt" type="date" />
        </label>
        <p v-if="modalMessage" class="modal-error">{{ modalMessage }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">提交登记</button>
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
        </div>
      </form>
    </div>

    <!-- 登记损坏：同一盏灯反复登记只认第一次，后到整条退回 -->
    <div v-if="modal === 'damage'" class="modal-mask" @click.self="closeModal">
      <form class="modal-card" @submit.prevent="submitDamage">
        <h3>登记灯具损坏</h3>
        <p class="modal-scope">提交岗位：{{ store.operator }} · {{ store.postName }}</p>
        <label class="form-item">
          <span>损坏灯具</span>
          <select v-model.number="damageForm.lampId">
            <option :value="0" disabled>请选择灯具（编号 · 位置）</option>
            <option v-for="lamp in damageCandidates" :key="lamp.id" :value="lamp.id">
              {{ lamp.灯具编号 }} · {{ lamp.安装位置 }} · {{ lamp.status }}
            </option>
          </select>
        </label>
        <label class="form-item">
          <span>损坏情况</span>
          <textarea v-model="damageForm.damageNote" rows="3" placeholder="如：灯具不亮，灯罩破损，需整体更换"></textarea>
        </label>
        <p class="modal-hint">提交后整笔落库：灯具转「已损坏」、设施检修管理生成更换待办、值班遗留清单同步出现，条数一致；流程任一环不过则整笔退回。</p>
        <p v-if="modalMessage" class="modal-error">{{ modalMessage }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">提交损坏登记</button>
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listLightingReports,
  listReplacementTodos,
  moduleMeta,
} from '@/api/local-service'
import {
  CABINS,
  cabinName,
  scopeOf,
} from '@/domain/access'
import {
  registerLamp,
  reportDamage,
  type DamageReport,
  type LightingLamp,
} from '@/domain/lighting'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const meta = moduleMeta('lighting')
const columns = ["灯具编号", "所属舱室", "灯具类型", "安装位置", "额定功率", "验收日期", "责任岗位", "登记时间", "巡检日期", "巡检人员"]
const statuses = ["待巡检", "巡检中", "照明正常", "已损坏"]

const cabins = CABINS
const rows = ref<LightingLamp[]>([])
const reports = ref<DamageReport[]>([])
const total = ref(0)
const openTodoCount = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["灯具编号", "所属舱室", "安装位置"]
const selectedId = ref<number | null>(null)

const modal = ref<'' | 'register' | 'damage'>('')
const modalMessage = ref('')
const registerForm = ref({ cabinCode: 'A', position: '', lampType: 'LED防潮灯', watt: '36W', acceptedAt: '' })
const damageForm = ref({ lampId: 0, damageNote: '' })

const scope = computed(() => scopeOf(store.postId))
const canMutate = computed(() => scope.value.canMutateLighting)
const ownerCabinName = computed(() =>
  scope.value.cabinCode ? cabinName(scope.value.cabinCode) : '无归属舱室',
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '在册灯具', value: rows.value.length },
  { label: '照明正常灯具', value: rows.value.filter((row) => row.status === '照明正常').length },
  { label: '已损坏待更换', value: openTodoCount.value },
])

const selected = computed<LightingLamp | null>(() =>
  selectedId.value === null ? null : rows.value.find((row) => row.id === selectedId.value) ?? null,
)

function positionsOf(code: string) {
  return cabins.find((cabin) => cabin.code === code)?.positions ?? []
}

// 损坏灯具下拉：归属岗位只看到本舱室灯具；其余岗位打开也会被服务端驳回（双保险）。
const damageCandidates = computed(() => {
  const code = scope.value.cabinCode
  const pool = code ? rows.value.filter((lamp) => lamp.所属舱室 === cabinName(code)) : rows.value
  return pool
})

function reportsOf(lampId: number): DamageReport[] {
  return reports.value.filter((report) => report.lampId === lampId)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function selectRow(id: number) {
  selectedId.value = id
}

function openRegister() {
  errorMessage.value = ''
  modalMessage.value = ''
  registerForm.value = {
    cabinCode: scope.value.cabinCode ?? 'A',
    position: '',
    lampType: 'LED防潮灯',
    watt: '36W',
    acceptedAt: '',
  }
  modal.value = 'register'
}

function openDamage() {
  errorMessage.value = ''
  modalMessage.value = ''
  damageForm.value = {
    lampId: selectedId.value ?? 0,
    damageNote: '',
  }
  modal.value = 'damage'
}

function openDamageFor(row: LightingLamp) {
  selectedId.value = Number(row.id)
  openDamage()
}

function closeModal() {
  modal.value = ''
  modalMessage.value = ''
}

function submitRegister() {
  const result = registerLamp({
    postId: store.postId,
    accountName: store.operator,
    cabinCode: registerForm.value.cabinCode,
    lampType: registerForm.value.lampType,
    position: registerForm.value.position,
    watt: registerForm.value.watt,
    acceptedAt: registerForm.value.acceptedAt,
  })
  if (!result.ok) {
    modalMessage.value = result.message
    return
  }
  closeModal()
  reload()
  errorMessage.value = result.message
}

function submitDamage() {
  if (!damageForm.value.lampId) {
    modalMessage.value = '请选择要登记损坏的灯具'
    return
  }
  const result = reportDamage({
    postId: store.postId,
    accountName: store.operator,
    lampId: damageForm.value.lampId,
    damageNote: damageForm.value.damageNote,
  })
  if (!result.ok) {
    modalMessage.value = result.message
    return
  }
  closeModal()
  reload()
  errorMessage.value = result.message
}

function reload() {
  errorMessage.value = ''
  try {
    // 列表、详情、统计全部来自这一次读取，面板之间不可能出现条数不一致。
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items as unknown as LightingLamp[]
    total.value = payload.total
    const todos = listReplacementTodos()
    reports.value = listLightingReports()
    openTodoCount.value = todos.length
    if (selectedId.value !== null && !rows.value.some((row) => row.id === selectedId.value)) {
      selectedId.value = null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊内照明运维列表读取失败'
  }
}

onMounted(reload)
</script>
