import { defineStore } from 'pinia'

import { ACCOUNTS, accountOf, type Account } from '@/data/access'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: ACCOUNTS[0].name,
    accountId: ACCOUNTS[0].id,
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    account(state): Account {
      return accountOf(state.accountId)
    },
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setAccount(id: string) {
      const account = accountOf(id)
      this.accountId = account.id
      this.operator = account.name
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
