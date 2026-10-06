import { defineStore } from 'pinia'

import {
  ACCOUNTS,
  DEFAULT_ACCOUNT_ID,
  accountById,
  postById,
  scopeOf,
  type Account,
  type Post,
} from '@/domain/access'

// 受控入口统一从会话里取「当前账号 → 岗位 → 归属舱室」。
// 切换账号只是为了演示和验收归属管控；服务层每次提交都重新核对岗位与归属，不信前端按钮。
export const useSessionStore = defineStore('session', {
  state: () => {
    const account = accountById(DEFAULT_ACCOUNT_ID) as Account
    const post = postById(account.postId) as Post
    return {
      accountId: account.id,
      operator: account.name,
      postId: post.id,
      postName: post.name,
      role: post.role,
      shiftLabel: '白班 08:00-20:00',
      scope: '城市地下综合管廊运行维护管理平台',
    }
  },
  getters: {
    canOperate: (state) => state.operator.length > 0,
    accounts: () => ACCOUNTS,
    cabinScope: (state) => scopeOf(state.postId),
    // 是否能改动灯具台账：仅本舱室照明责任岗位为 true，其余账号一律只读。
    canMutateLighting: (state) => scopeOf(state.postId).canMutateLighting,
    isRepairCrew: (state) => scopeOf(state.postId).isRepairCrew,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchAccount(accountId: string) {
      const account = accountById(accountId)
      if (!account) {
        return
      }
      const post = postById(account.postId)
      if (!post) {
        return
      }
      this.accountId = account.id
      this.operator = account.name
      this.postId = post.id
      this.postName = post.name
      this.role = post.role
    },
  },
})
