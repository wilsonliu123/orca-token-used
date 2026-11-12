import type { AgentKind, AgentRunState, ViewTab } from '../protocol'

export type SupportedLocale = 'zh-TW' | 'zh-CN' | 'en' | 'ja' | 'ko'

export interface UiMessages {
  appTitle: string
  tabs: Record<ViewTab, string>
  navShort: Record<ViewTab, string>
  tabSubtitles: Record<ViewTab, string>
  scopeAll: string
  scopeWorktree: string
  refreshTooltip: string
  syncPricingTooltip: string
  liveTpsLabel: string
  peakLabel: string
  avgLabel: string
  activeTokensLabel: string
  liveCostLabel: string
  periodCostLabel: string
  totalTokensLabel: string
  vsPrevious: string
  inputShort: string
  cacheShort: string
  outputShort: string
  costShort: string
  runningAgentsHeader: string
  clickToInspectHint: string
  backToAgents: string
  outputStreamLabel: string
  inputStreamLabel: string
  live1sBadge: string
  noLiveAgents: string
  noSessionsInWorktree: string
  noPeriodData: string
  sessionsCountSuffix: string
  sortedNewestHint: string
  worktreePrefix: string
  allWorkspacesFallback: string
  chartHourHeader: string
  chartWeekHeader: string
  chartMonthHeader: string
  byAgentHeader: string
  pricingOnline: string
  pricingCached: string
  pricingBuiltin: string
  justNow: string
  minutesAgo: (m: number) => string
  hoursAgo: (h: number) => string
  daysAgo: (d: number) => string
  activeBadge: string
  states: Record<AgentRunState, string>
  agentNames: Record<AgentKind, string>
}

const MESSAGES: Record<SupportedLocale, UiMessages> = {
  'zh-TW': {
    appTitle: 'Token 算力脈衝',
    tabs: {
      live: '即時監控',
      sessions: '當前 Worktree 對話',
      day: '今日統計',
      week: '本週統計',
      month: '本月統計'
    },
    navShort: {
      live: '即時',
      sessions: '對話',
      day: '今日',
      week: '本週',
      month: '本月'
    },
    tabSubtitles: {
      live: '即時 Agent 狀態、模型與 I/O 脈衝速率',
      sessions: '依左側聚焦專案與 Worktree 由新到舊排列',
      day: '今日 24 小時累計 Token 與費用',
      week: '近 7 天累計趨勢與 Agent 佔比',
      month: '近 30 天累計趨勢與 Agent 佔比'
    },
    scopeAll: '全機',
    scopeWorktree: '當前 Worktree',
    refreshTooltip: '重新掃描對話紀錄與即時費率',
    syncPricingTooltip: '立即同步最新線上官方費率',
    liveTpsLabel: '即時生成 TPS',
    peakLabel: '峰值',
    avgLabel: '平均',
    activeTokensLabel: '活躍 Token 數',
    liveCostLabel: '即時預估費用',
    periodCostLabel: '累計預估費用',
    totalTokensLabel: '總 Token 消耗',
    vsPrevious: '較前一週期',
    inputShort: '輸入',
    cacheShort: '快取',
    outputShort: '輸出',
    costShort: '費用',
    runningAgentsHeader: '執行與待命中的 Agent',
    clickToInspectHint: '點擊展開 1s I/O 波形',
    backToAgents: '返回全部 Agent',
    outputStreamLabel: '模型輸出 · 回覆速度',
    inputStreamLabel: '送入模型 · 上下文速度',
    live1sBadge: '1s 即時',
    noLiveAgents: '目前沒有正在活動的 Agent Session',
    noSessionsInWorktree: '當前專案 Worktree 尚無對話紀錄',
    noPeriodData: '此統計區間內尚無 Token 消耗紀錄',
    sessionsCountSuffix: '個對話',
    sortedNewestHint: '由新到舊排序',
    worktreePrefix: '專案 / Worktree',
    allWorkspacesFallback: '未聚焦特定 Worktree（顯示全部）',
    chartHourHeader: '今日各小時分佈（00:00–24:00）',
    chartWeekHeader: '近 7 天分佈趨勢',
    chartMonthHeader: '近 30 天分佈趨勢',
    byAgentHeader: '各 Agent 消耗、費用與 TPS',
    pricingOnline: '線上即時費率',
    pricingCached: '快取費率',
    pricingBuiltin: '內建基準費率',
    justNow: '剛剛',
    minutesAgo: (m) => `${m} 分鐘前`,
    hoursAgo: (h) => `${h} 小時前`,
    daysAgo: (d) => `${d} 天前`,
    activeBadge: '進行中',
    states: {
      working: '執行中',
      waiting: '待命中',
      blocked: '等待授權',
      done: '已完成'
    },
    agentNames: {
      claude: 'Claude Code',
      codex: 'Codex',
      antigravity: 'Antigravity',
      gemini: 'Gemini CLI'
    }
  },
  'zh-CN': {
    appTitle: 'Token 算力脉冲',
    tabs: {
      live: '实时监控',
      sessions: '当前 Worktree 对话',
      day: '今日统计',
      week: '本周统计',
      month: '本月统计'
    },
    navShort: {
      live: '实时',
      sessions: '对话',
      day: '今日',
      week: '本周',
      month: '本月'
    },
    tabSubtitles: {
      live: '实时 Agent 状态、模型与 I/O 脉冲速率',
      sessions: '按左侧聚焦项目与 Worktree 从新到旧排列',
      day: '今日 24 小时累计 Token 与费用',
      week: '近 7 天累计趋势与 Agent 占比',
      month: '近 30 天累计趋势与 Agent 占比'
    },
    scopeAll: '全机',
    scopeWorktree: '当前 Worktree',
    refreshTooltip: '重新扫描对话记录与实时费率',
    syncPricingTooltip: '立即同步最新线上官方费率',
    liveTpsLabel: '实时生成 TPS',
    peakLabel: '峰值',
    avgLabel: '平均',
    activeTokensLabel: '活跃 Token 数',
    liveCostLabel: '实时预估费用',
    periodCostLabel: '累计预估费用',
    totalTokensLabel: '总 Token 消耗',
    vsPrevious: '较上一周期',
    inputShort: '输入',
    cacheShort: '缓存',
    outputShort: '输出',
    costShort: '费用',
    runningAgentsHeader: '运行与待命中的 Agent',
    clickToInspectHint: '点击展开 1s I/O 波形',
    backToAgents: '返回全部 Agent',
    outputStreamLabel: '模型输出 · 回复速度',
    inputStreamLabel: '送入模型 · 上下文速度',
    live1sBadge: '1s 实时',
    noLiveAgents: '当前没有活动中的 Agent 会话',
    noSessionsInWorktree: '当前项目 Worktree 暂无对话记录',
    noPeriodData: '该统计区间暂无 Token 消耗记录',
    sessionsCountSuffix: '个对话',
    sortedNewestHint: '按从新到旧排序',
    worktreePrefix: '项目 / Worktree',
    allWorkspacesFallback: '未聚焦特定 Worktree（显示全部）',
    chartHourHeader: '今日各小时分布（00:00–24:00）',
    chartWeekHeader: '近 7 天分布趋势',
    chartMonthHeader: '近 30 天分布趋势',
    byAgentHeader: '各 Agent 消耗、费用与 TPS',
    pricingOnline: '在线实时费率',
    pricingCached: '缓存费率',
    pricingBuiltin: '内置基准费率',
    justNow: '刚刚',
    minutesAgo: (m) => `${m} 分钟前`,
    hoursAgo: (h) => `${h} 小时前`,
    daysAgo: (d) => `${d} 天前`,
    activeBadge: '进行中',
    states: {
      working: '运行中',
      waiting: '待命中',
      blocked: '等待确认',
      done: '已完成'
    },
    agentNames: {
      claude: 'Claude Code',
      codex: 'Codex',
      antigravity: 'Antigravity',
      gemini: 'Gemini CLI'
    }
  },
  en: {
    appTitle: 'Token Pulse',
    tabs: {
      live: 'Live Monitor',
      sessions: 'Worktree Conversations',
      day: 'Today',
      week: 'This Week',
      month: 'This Month'
    },
    navShort: {
      live: 'Live',
      sessions: 'Sessions',
      day: 'Today',
      week: 'Week',
      month: 'Month'
    },
    tabSubtitles: {
      live: 'Active agents, provider models & live I/O telemetry',
      sessions: 'Focused project & worktree sessions sorted newest first',
      day: '24-hour token consumption & estimated spend',
      week: 'Last 7 days trend & agent breakdown',
      month: 'Last 30 days trend & agent breakdown'
    },
    scopeAll: 'All Machine',
    scopeWorktree: 'Worktree',
    refreshTooltip: 'Rescan transcripts & live pricing',
    syncPricingTooltip: 'Sync latest online official model rates',
    liveTpsLabel: 'LIVE TPS',
    peakLabel: 'Peak',
    avgLabel: 'Avg',
    activeTokensLabel: 'ACTIVE TOKENS',
    liveCostLabel: 'LIVE COST',
    periodCostLabel: 'EST. COST',
    totalTokensLabel: 'TOTAL TOKENS',
    vsPrevious: 'vs prior period',
    inputShort: 'In',
    cacheShort: 'Cache',
    outputShort: 'Out',
    costShort: 'Cost',
    runningAgentsHeader: 'ACTIVE & RECENT AGENTS',
    clickToInspectHint: 'Click agent for 1s I/O stream',
    backToAgents: 'All Agents',
    outputStreamLabel: 'MODEL OUTPUT · REPLY RATE',
    inputStreamLabel: 'MODEL INPUT · CONTEXT RATE',
    live1sBadge: '1s LIVE',
    noLiveAgents: 'No active agent sessions right now',
    noSessionsInWorktree: 'No conversations recorded in this project worktree yet',
    noPeriodData: 'No token usage recorded in this window',
    sessionsCountSuffix: 'conversations',
    sortedNewestHint: 'Sorted newest to oldest',
    worktreePrefix: 'Project / Worktree',
    allWorkspacesFallback: 'All workspaces',
    chartHourHeader: 'TODAY BY HOUR (00:00–24:00)',
    chartWeekHeader: 'LAST 7 DAYS',
    chartMonthHeader: 'LAST 30 DAYS',
    byAgentHeader: 'BY AGENT · TOKENS, COST & TPS',
    pricingOnline: 'Live online rates',
    pricingCached: 'Cached rates',
    pricingBuiltin: 'Baseline rates',
    justNow: 'Just now',
    minutesAgo: (m) => `${m}m ago`,
    hoursAgo: (h) => `${h}h ago`,
    daysAgo: (d) => `${d}d ago`,
    activeBadge: 'active',
    states: {
      working: 'working',
      waiting: 'waiting',
      blocked: 'blocked',
      done: 'done'
    },
    agentNames: {
      claude: 'Claude Code',
      codex: 'Codex',
      antigravity: 'Antigravity',
      gemini: 'Gemini CLI'
    }
  },
  ja: {
    appTitle: 'Token Pulse',
    tabs: {
      live: 'ライブ監視',
      sessions: '会話セッション',
      day: '今日',
      week: '週間',
      month: '月間'
    },
    navShort: {
      live: 'ライブ',
      sessions: '会話',
      day: '今日',
      week: '週間',
      month: '月間'
    },
    tabSubtitles: {
      live: '実行中エージェント・モデル・I/O ストリーム',
      sessions: '選択中のプロジェクト＆ワークツリーの会話（新しい順）',
      day: '過去24時間のトークン消費と推定コスト',
      week: '過去7日間の推移とエージェント別内訳',
      month: '過去30日間の推移とエージェント別内訳'
    },
    scopeAll: 'マシン全体',
    scopeWorktree: 'ワークツリー',
    refreshTooltip: 'ログと最新料金を再スキャン',
    syncPricingTooltip: '最新の公式モデル料金を同期',
    liveTpsLabel: 'リアルタイム TPS',
    peakLabel: 'ピーク',
    avgLabel: '平均',
    activeTokensLabel: 'アクティブトークン',
    liveCostLabel: 'リアルタイム費用',
    periodCostLabel: '推定コスト',
    totalTokensLabel: '合計トークン',
    vsPrevious: '前期間比',
    inputShort: '入力',
    cacheShort: 'キャッシュ',
    outputShort: '出力',
    costShort: '費用',
    runningAgentsHeader: '稼働中・待機中のエージェント',
    clickToInspectHint: 'クリックで 1秒 I/O 波形',
    backToAgents: '一覧へ戻る',
    outputStreamLabel: 'モデル出力 · 返信速度',
    inputStreamLabel: 'モデル入力 · コンテキスト速度',
    live1sBadge: '1s LIVE',
    noLiveAgents: '現在稼働中のエージェントはありません',
    noSessionsInWorktree: 'このプロジェクトのワークツリーには会話履歴がありません',
    noPeriodData: 'この期間のトークン記録はありません',
    sessionsCountSuffix: '件の会話',
    sortedNewestHint: '新しい順',
    worktreePrefix: 'プロジェクト',
    allWorkspacesFallback: 'すべてのワークスペース',
    chartHourHeader: '時間帯別推移（00:00–24:00）',
    chartWeekHeader: '過去7日間の推移',
    chartMonthHeader: '過去30日間の推移',
    byAgentHeader: 'エージェント別内訳・費用・TPS',
    pricingOnline: 'オンライン最新料金',
    pricingCached: 'キャッシュ料金',
    pricingBuiltin: '標準料金',
    justNow: 'たった今',
    minutesAgo: (m) => `${m}分前`,
    hoursAgo: (h) => `${h}時間前`,
    daysAgo: (d) => `${d}日前`,
    activeBadge: '実行中',
    states: {
      working: '実行中',
      waiting: '待機中',
      blocked: '承認待ち',
      done: '完了'
    },
    agentNames: {
      claude: 'Claude Code',
      codex: 'Codex',
      antigravity: 'Antigravity',
      gemini: 'Gemini CLI'
    }
  },
  ko: {
    appTitle: 'Token Pulse',
    tabs: {
      live: '실시간 모니터',
      sessions: '워크트리 대화',
      day: '오늘',
      week: '주간',
      month: '월간'
    },
    navShort: {
      live: '실시간',
      sessions: '대화',
      day: '오늘',
      week: '주간',
      month: '월간'
    },
    tabSubtitles: {
      live: '실행 중인 에이전트, 모델 및 실시간 I/O 파형',
      sessions: '선택된 프로젝트 및 워크트리 대화 목록 (최신순)',
      day: '오늘 24시간 토큰 사용량 및 예상 비용',
      week: '최근 7일 추이 및 에이전트별 비중',
      month: '최근 30일 추이 및 에이전트별 비중'
    },
    scopeAll: '전체 기기',
    scopeWorktree: '워크트리',
    refreshTooltip: '세션 기록 및 실시간 요금 새로고침',
    syncPricingTooltip: '최신 공식 모델 요금 동기화',
    liveTpsLabel: '실시간 TPS',
    peakLabel: '최대',
    avgLabel: '평균',
    activeTokensLabel: '활성 토큰',
    liveCostLabel: '실시간 비용',
    periodCostLabel: '예상 비용',
    totalTokensLabel: '총 토큰',
    vsPrevious: '이전 기간 대비',
    inputShort: '입력',
    cacheShort: '캐시',
    outputShort: '출력',
    costShort: '비용',
    runningAgentsHeader: '실행 및 대기 중인 에이전트',
    clickToInspectHint: '클릭하여 1초 I/O 파형 보기',
    backToAgents: '전체 에이전트',
    outputStreamLabel: '모델 출력 · 응답 속도',
    inputStreamLabel: '모델 입력 · 컨텍스트 속도',
    live1sBadge: '1s LIVE',
    noLiveAgents: '현재 활성화된 에이전트 세션이 없습니다',
    noSessionsInWorktree: '현재 프로젝트 워크트리에 대화 기록이 없습니다',
    noPeriodData: '이 기간에 기록된 토큰 사용량이 없습니다',
    sessionsCountSuffix: '개 대화',
    sortedNewestHint: '최신순 정렬',
    worktreePrefix: '프로젝트',
    allWorkspacesFallback: '전체 워크스페이스',
    chartHourHeader: '시간대별 분포 (00:00–24:00)',
    chartWeekHeader: '최근 7일 추이',
    chartMonthHeader: '최근 30일 추이',
    byAgentHeader: '에이전트별 토큰 · 비용 · TPS',
    pricingOnline: '실시간 온라인 요금',
    pricingCached: '캐시된 요금',
    pricingBuiltin: '기본 요금',
    justNow: '방금 전',
    minutesAgo: (m) => `${m}분 전`,
    hoursAgo: (h) => `${h}시간 전`,
    daysAgo: (d) => `${d}일 전`,
    activeBadge: '활성',
    states: {
      working: '작업 중',
      waiting: '대기 중',
      blocked: '승인 대기',
      done: '완료'
    },
    agentNames: {
      claude: 'Claude Code',
      codex: 'Codex',
      antigravity: 'Antigravity',
      gemini: 'Gemini CLI'
    }
  }
}

export function resolveLocale(bcp47: string | null | undefined): SupportedLocale {
  const tag = (bcp47 || 'en').trim().toLowerCase()
  if (tag.startsWith('zh')) {
    if (
      tag.includes('tw') ||
      tag.includes('hk') ||
      tag.includes('mo') ||
      tag.includes('hant')
    ) {
      return 'zh-TW'
    }
    return 'zh-CN'
  }
  if (tag.startsWith('ja')) return 'ja'
  if (tag.startsWith('ko')) return 'ko'
  return 'en'
}

export function getMessages(bcp47: string | null | undefined): UiMessages {
  return MESSAGES[resolveLocale(bcp47)]
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(Math.round(n))
}

export function formatRateTokPerSec(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0 tok/s'
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)}M tok/s`
  if (rate >= 10_000) return `${Math.round(rate / 1_000)}K tok/s`
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}K tok/s`
  if (rate >= 100) return `${Math.round(rate)} tok/s`
  return `${rate.toFixed(1)} tok/s`
}

export function formatScaleTokPerSec(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0/s'
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)}M/s`
  if (rate >= 10_000) return `${Math.round(rate / 1_000)}K/s`
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}K/s`
  return `${Math.round(rate)} tok/s`
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.001) return '<$0.001'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(2)}`
}

export function formatRelativeTime(tsMs: number, nowMs: number, msg: UiMessages): string {
  if (!tsMs || tsMs <= 0) return ''
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000))
  if (diffSec < 60) return msg.justNow
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return msg.minutesAgo(mins)
  const hours = Math.floor(mins / 60)
  if (hours < 24) return msg.hoursAgo(hours)
  const days = Math.floor(hours / 24)
  return msg.daysAgo(days)
}
