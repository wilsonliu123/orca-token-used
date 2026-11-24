import type { AgentKind, AgentRunState, ViewTab } from '../protocol'

export type SupportedLocale = 'zh-TW' | 'zh-CN' | 'en' | 'ja' | 'ko' | 'cs'

export interface UiMessages {
  appTitle: string
  tabs: Record<ViewTab, string>
  navShort: Record<ViewTab, string> & { stats: string }
  breakdownModes: { agent: string; model: string; project: string }
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
  todayCostLabel: string
  periodCostLabel: string
  totalTokensLabel: string
  vsPrevious: string
  inputShort: string
  cacheShort: string
  outputShort: string
  costShort: string
  runningAgentsHeader: string
  liveRaceLabel: string
  raceThinking: (count: number) => string
  raceWaiting: (count: number) => string
  raceSubagentsShort: (count: number) => string
  subagentsHeader: string
  backgroundTasksHeader: string
  reasoningLabel: string
  reasoningNotRecorded: string
  clickToInspectHint: string
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
  pricingModelsLoaded: (count: number) => string
  pricingModelsTooltip: string
  justNow: string
  minutesAgo: (m: number) => string
  hoursAgo: (h: number) => string
  daysAgo: (d: number) => string
  activeBadge: string
  quota5hLabel: string
  quotaWeeklyLabel: string
  quotaUsedLabel: string
  quotaResetsIn: (countdown: string) => string
  quotaResetSoon: string
  quotaNotApplicable: string
  quotaWeeklyOnlyHint: string
  quotaResetCredits: (count: number) => string
  quotaNextExpiry: (when: string) => string
  quotaLocalUsage5h: string
  quotaLocalUsage7d: string
  quotaTurnsShort: (count: number) => string
  quotaRateLimitsShort: (count: number) => string
  quotaUnavailableLabel: string
  quotaErrorLabel: string
  quotaLoadingLabel: string
  quotaNoDataLabel: string
  quotaSourceLive: string
  quotaSourceCache: string
  quotaSourceLoading: string
  quotaSourceError: string
  quotaRefreshAction: string
  quotaOtherAccounts: string
  quotaActiveAccountBadge: string
  quotaStatusOk: string
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
      month: '本月統計',
      quotas: '額度監控'
    },
    navShort: {
      live: '即時',
      sessions: '對話',
      day: '今日',
      week: '本週',
      month: '本月',
      quotas: '額度',
      stats: '統計'
    },
    breakdownModes: {
      agent: 'Agent',
      model: '模型',
      project: '專案'
    },
    tabSubtitles: {
      live: '即時 Agent 狀態、模型與 I/O 脈衝速率',
      sessions: '依左側聚焦專案與 Worktree 由新到舊排列',
      day: '今日 24 小時累計 Token 與費用',
      week: '近 7 天累計趨勢與 Agent 佔比',
      month: '近 30 天累計趨勢與 Agent 佔比',
      quotas: 'Codex、Antigravity 與 Claude 的 5 小時與每週額度'
    },
    scopeAll: '全機',
    scopeWorktree: '當前 Worktree',
    refreshTooltip: '重新掃描對話紀錄與即時費率',
    syncPricingTooltip: '立即同步最新線上官方費率',
    liveTpsLabel: '即時生成 TPS',
    peakLabel: '峰值',
    avgLabel: '平均',
    activeTokensLabel: '活躍 Token 數',
    liveCostLabel: '活躍對話累計費用',
    todayCostLabel: '今日累計費用',
    periodCostLabel: '累計預估費用',
    totalTokensLabel: '總 Token 消耗',
    vsPrevious: '較前一週期',
    inputShort: '輸入',
    cacheShort: '快取',
    outputShort: '輸出',
    costShort: '費用',
    runningAgentsHeader: '執行與待命中的 Agent',
    liveRaceLabel: '即時競速',
    raceThinking: (count) => `${count} 思考中`,
    raceWaiting: (count) => `${count} 等待中`,
    raceSubagentsShort: (count) => `${count} 子任務`,
    subagentsHeader: 'Subagent 工作階段',
    backgroundTasksHeader: '背景任務',
    reasoningLabel: '推理等級',
    reasoningNotRecorded: '—',
    clickToInspectHint: '點擊查看 I/O；有終端時同步聚焦',
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
    pricingModelsLoaded: (count) => `${count} 個模型價格已載入`,
    pricingModelsTooltip: '這是系統已知價格的模型數量，不是目前正在使用的模型數量。',
    justNow: '剛剛',
    minutesAgo: (m) => `${m} 分鐘前`,
    hoursAgo: (h) => `${h} 小時前`,
    daysAgo: (d) => `${d} 天前`,
    activeBadge: '進行中',
    quota5hLabel: '5 小時視窗',
    quotaWeeklyLabel: '每週 (7d)',
    quotaUsedLabel: '已用',
    quotaResetsIn: (countdown) => `${countdown}後重置`,
    quotaResetSoon: '即將重置',
    quotaNotApplicable: '不適用',
    quotaWeeklyOnlyHint: '僅含每週額度 · 無 5 小時上限',
    quotaResetCredits: (count) => `${count} 次重置額度`,
    quotaNextExpiry: (when) => `到期 ${when}`,
    quotaLocalUsage5h: '本機 5h',
    quotaLocalUsage7d: '本機 7d',
    quotaTurnsShort: (count) => `${count} 輪`,
    quotaRateLimitsShort: (count) => `${count} × 429`,
    quotaUnavailableLabel: '官方方案額度不可用',
    quotaErrorLabel: '額度讀取失敗',
    quotaLoadingLabel: '正在取得即時額度…',
    quotaNoDataLabel: '尚未載入額度資料',
    quotaSourceLive: '即時額度',
    quotaSourceCache: '快取額度',
    quotaSourceLoading: '同步額度中…',
    quotaSourceError: '額度同步錯誤',
    quotaRefreshAction: '重新整理',
    quotaOtherAccounts: '帳號列表',
    quotaActiveAccountBadge: '使用中',
    quotaStatusOk: '正常',
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
      month: '本月统计',
      quotas: '额度监控'
    },
    navShort: {
      live: '实时',
      sessions: '对话',
      day: '今日',
      week: '本周',
      month: '本月',
      quotas: '额度',
      stats: '统计'
    },
    breakdownModes: {
      agent: 'Agent',
      model: '模型',
      project: '项目'
    },
    tabSubtitles: {
      live: '实时 Agent 状态、模型与 I/O 脉冲速率',
      sessions: '按左侧聚焦项目与 Worktree 从新到旧排列',
      day: '今日 24 小时累计 Token 与费用',
      week: '近 7 天累计趋势与 Agent 占比',
      month: '近 30 天累计趋势与 Agent 占比',
      quotas: 'Codex、Antigravity 与 Claude 的 5 小时及每周额度'
    },
    scopeAll: '全机',
    scopeWorktree: '当前 Worktree',
    refreshTooltip: '重新扫描对话记录与实时费率',
    syncPricingTooltip: '立即同步最新线上官方费率',
    liveTpsLabel: '实时生成 TPS',
    peakLabel: '峰值',
    avgLabel: '平均',
    activeTokensLabel: '活跃 Token 数',
    liveCostLabel: '活跃对话累计费用',
    todayCostLabel: '今日累计费用',
    periodCostLabel: '累计预估费用',
    totalTokensLabel: '总 Token 消耗',
    vsPrevious: '较上一周期',
    inputShort: '输入',
    cacheShort: '缓存',
    outputShort: '输出',
    costShort: '费用',
    runningAgentsHeader: '运行与待命中的 Agent',
    liveRaceLabel: '实时竞速',
    raceThinking: (count) => `${count} 思考中`,
    raceWaiting: (count) => `${count} 等待中`,
    raceSubagentsShort: (count) => `${count} 子任务`,
    subagentsHeader: 'Subagent 会话',
    backgroundTasksHeader: '后台任务',
    reasoningLabel: '推理等级',
    reasoningNotRecorded: '—',
    clickToInspectHint: '点击查看 I/O；有终端时同步聚焦',
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
    pricingModelsLoaded: (count) => `已加载 ${count} 个模型价格`,
    pricingModelsTooltip: '这是系统已知价格的模型数量，不是当前正在使用的模型数量。',
    justNow: '刚刚',
    minutesAgo: (m) => `${m} 分钟前`,
    hoursAgo: (h) => `${h} 小时前`,
    daysAgo: (d) => `${d} 天前`,
    activeBadge: '进行中',
    quota5hLabel: '5 小时窗口',
    quotaWeeklyLabel: '每周 (7d)',
    quotaUsedLabel: '已用',
    quotaResetsIn: (countdown) => `${countdown}后重置`,
    quotaResetSoon: '即将重置',
    quotaNotApplicable: '不适用',
    quotaWeeklyOnlyHint: '仅含每周额度 · 无 5 小时上限',
    quotaResetCredits: (count) => `${count} 次重置额度`,
    quotaNextExpiry: (when) => `到期 ${when}`,
    quotaLocalUsage5h: '本地 5h',
    quotaLocalUsage7d: '本地 7d',
    quotaTurnsShort: (count) => `${count} 轮`,
    quotaRateLimitsShort: (count) => `${count} × 429`,
    quotaUnavailableLabel: '官方方案额度不可用',
    quotaErrorLabel: '额度读取失败',
    quotaLoadingLabel: '正在获取实时额度…',
    quotaNoDataLabel: '尚未加载额度数据',
    quotaSourceLive: '实时额度',
    quotaSourceCache: '缓存额度',
    quotaSourceLoading: '同步额度中…',
    quotaSourceError: '额度同步错误',
    quotaRefreshAction: '刷新',
    quotaOtherAccounts: '账号列表',
    quotaActiveAccountBadge: '使用中',
    quotaStatusOk: '正常',
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
      month: 'This Month',
      quotas: 'Quotas & Limits'
    },
    navShort: {
      live: 'Live',
      sessions: 'Sessions',
      day: 'Today',
      week: 'Week',
      month: 'Month',
      quotas: 'Quotas',
      stats: 'Stats'
    },
    breakdownModes: {
      agent: 'Agent',
      model: 'Model',
      project: 'Project'
    },
    tabSubtitles: {
      live: 'Active agents, provider models & live I/O telemetry',
      sessions: 'Focused project & worktree sessions sorted newest first',
      day: '24-hour token consumption & estimated spend',
      week: 'Last 7 days trend & agent breakdown',
      month: 'Last 30 days trend & agent breakdown',
      quotas: '5-hour & weekly plan limits across Codex, Antigravity & Claude'
    },
    scopeAll: 'All Machine',
    scopeWorktree: 'Worktree',
    refreshTooltip: 'Rescan transcripts & live pricing',
    syncPricingTooltip: 'Sync latest online official model rates',
    liveTpsLabel: 'LIVE TPS',
    peakLabel: 'Peak',
    avgLabel: 'Avg',
    activeTokensLabel: 'ACTIVE TOKENS',
    liveCostLabel: 'ACTIVE SESSION COST',
    todayCostLabel: 'TODAY COST',
    periodCostLabel: 'EST. COST',
    totalTokensLabel: 'TOTAL TOKENS',
    vsPrevious: 'vs prior period',
    inputShort: 'In',
    cacheShort: 'Cache',
    outputShort: 'Out',
    costShort: 'Cost',
    runningAgentsHeader: 'ACTIVE & RECENT AGENTS',
    liveRaceLabel: 'LIVE RACE',
    raceThinking: (count) => `${count} thinking`,
    raceWaiting: (count) => `${count} waiting`,
    raceSubagentsShort: (count) => `${count} sub`,
    subagentsHeader: 'SUBAGENT SESSIONS',
    backgroundTasksHeader: 'BACKGROUND TASKS',
    reasoningLabel: 'REASONING',
    reasoningNotRecorded: '—',
    clickToInspectHint: 'Click for I/O; focuses its terminal when available',
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
    pricingModelsLoaded: (count) => `${count} model prices loaded`,
    pricingModelsTooltip: 'The number of models with known prices, not the number of models currently in use.',
    justNow: 'Just now',
    minutesAgo: (m) => `${m}m ago`,
    hoursAgo: (h) => `${h}h ago`,
    daysAgo: (d) => `${d}d ago`,
    activeBadge: 'active',
    quota5hLabel: '5h Window',
    quotaWeeklyLabel: 'Weekly (7d)',
    quotaUsedLabel: 'used',
    quotaResetsIn: (countdown) => `Resets in ${countdown}`,
    quotaResetSoon: 'Resetting soon',
    quotaNotApplicable: 'N/A',
    quotaWeeklyOnlyHint: 'Weekly-only plan · No 5h limit',
    quotaResetCredits: (count) => `${count} reset credits`,
    quotaNextExpiry: (when) => `exp ${when}`,
    quotaLocalUsage5h: 'Local 5h',
    quotaLocalUsage7d: 'Local 7d',
    quotaTurnsShort: (count) => `${count} turns`,
    quotaRateLimitsShort: (count) => `${count} × 429`,
    quotaUnavailableLabel: 'Official quota unavailable',
    quotaErrorLabel: 'Quota check failed',
    quotaLoadingLabel: 'Checking provider quotas…',
    quotaNoDataLabel: 'Quota telemetry not loaded yet',
    quotaSourceLive: 'Live quotas',
    quotaSourceCache: 'Cached quotas',
    quotaSourceLoading: 'Syncing quotas…',
    quotaSourceError: 'Quota sync error',
    quotaRefreshAction: 'Refresh',
    quotaOtherAccounts: 'Accounts',
    quotaActiveAccountBadge: 'active',
    quotaStatusOk: 'OK',
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
      month: '月間',
      quotas: 'クォータ'
    },
    navShort: {
      live: 'ライブ',
      sessions: '会話',
      day: '今日',
      week: '週間',
      month: '月間',
      quotas: '枠',
      stats: '統計'
    },
    breakdownModes: {
      agent: 'Agent',
      model: 'モデル',
      project: 'プロジェクト'
    },
    tabSubtitles: {
      live: '実行中エージェント・モデル・I/O ストリーム',
      sessions: '選択中のプロジェクト＆ワークツリーの会話（新しい順）',
      day: '過去24時間のトークン消費と推定コスト',
      week: '過去7日間の推移とエージェント別内訳',
      month: '過去30日間の推移とエージェント別内訳',
      quotas: 'Codex・Antigravity・Claude の5時間／週間利用枠'
    },
    scopeAll: 'マシン全体',
    scopeWorktree: 'ワークツリー',
    refreshTooltip: 'ログと最新料金を再スキャン',
    syncPricingTooltip: '最新の公式モデル料金を同期',
    liveTpsLabel: 'リアルタイム TPS',
    peakLabel: 'ピーク',
    avgLabel: '平均',
    activeTokensLabel: 'アクティブトークン',
    liveCostLabel: 'アクティブセッション累計費用',
    todayCostLabel: '今日累計費用',
    periodCostLabel: '推定コスト',
    totalTokensLabel: '合計トークン',
    vsPrevious: '前期間比',
    inputShort: '入力',
    cacheShort: 'キャッシュ',
    outputShort: '出力',
    costShort: '費用',
    runningAgentsHeader: '稼働中・待機中のエージェント',
    liveRaceLabel: 'ライブレース',
    raceThinking: (count) => `${count} 思考中`,
    raceWaiting: (count) => `${count} 待機中`,
    raceSubagentsShort: (count) => `サブ ${count}`,
    subagentsHeader: 'サブエージェント セッション',
    backgroundTasksHeader: 'バックグラウンドタスク',
    reasoningLabel: '推論レベル',
    reasoningNotRecorded: '—',
    clickToInspectHint: 'クリックで I/O 表示（端末があればフォーカス）',
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
    pricingModelsLoaded: (count) => `${count} 個のモデル料金を読み込み済み`,
    pricingModelsTooltip: '価格が登録されているモデル数です。現在使用中のモデル数ではありません。',
    justNow: 'たった今',
    minutesAgo: (m) => `${m}分前`,
    hoursAgo: (h) => `${h}時間前`,
    daysAgo: (d) => `${d}日前`,
    activeBadge: '実行中',
    quota5hLabel: '5時間枠',
    quotaWeeklyLabel: '週間 (7d)',
    quotaUsedLabel: '使用済',
    quotaResetsIn: (countdown) => `あと ${countdown}`,
    quotaResetSoon: 'まもなくリセット',
    quotaNotApplicable: '対象外',
    quotaWeeklyOnlyHint: '週間プランのみ · 5時間枠なし',
    quotaResetCredits: (count) => `リセット枠 ${count}`,
    quotaNextExpiry: (when) => `期限 ${when}`,
    quotaLocalUsage5h: 'ローカル 5h',
    quotaLocalUsage7d: 'ローカル 7d',
    quotaTurnsShort: (count) => `${count} 回`,
    quotaRateLimitsShort: (count) => `${count} × 429`,
    quotaUnavailableLabel: '公式クォータ利用不可',
    quotaErrorLabel: 'クォータ取得エラー',
    quotaLoadingLabel: 'クォータを取得中…',
    quotaNoDataLabel: 'クォータ未読み込み',
    quotaSourceLive: 'ライブ枠',
    quotaSourceCache: 'キャッシュ枠',
    quotaSourceLoading: '同期中…',
    quotaSourceError: '同期エラー',
    quotaRefreshAction: '更新',
    quotaOtherAccounts: 'アカウント',
    quotaActiveAccountBadge: '有効',
    quotaStatusOk: '正常',
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
      month: '월간',
      quotas: '할당량'
    },
    navShort: {
      live: '실시간',
      sessions: '대화',
      day: '오늘',
      week: '주간',
      month: '월간',
      quotas: '한도',
      stats: '통계'
    },
    breakdownModes: {
      agent: 'Agent',
      model: '모델',
      project: '프로젝트'
    },
    tabSubtitles: {
      live: '실행 중인 에이전트, 모델 및 실시간 I/O 파형',
      sessions: '선택된 프로젝트 및 워크트리 대화 목록 (최신순)',
      day: '오늘 24시간 토큰 사용량 및 예상 비용',
      week: '최근 7일 추이 및 에이전트별 비중',
      month: '최근 30일 추이 및 에이전트별 비중',
      quotas: 'Codex, Antigravity, Claude의 5시간 및 주간 한도'
    },
    scopeAll: '전체 기기',
    scopeWorktree: '워크트리',
    refreshTooltip: '세션 기록 및 실시간 요금 새로고침',
    syncPricingTooltip: '최신 공식 모델 요금 동기화',
    liveTpsLabel: '실시간 TPS',
    peakLabel: '최대',
    avgLabel: '평균',
    activeTokensLabel: '활성 토큰',
    liveCostLabel: '활성 세션 누적 비용',
    todayCostLabel: '오늘 누적 비용',
    periodCostLabel: '예상 비용',
    totalTokensLabel: '총 토큰',
    vsPrevious: '이전 기간 대비',
    inputShort: '입력',
    cacheShort: '캐시',
    outputShort: '출력',
    costShort: '비용',
    runningAgentsHeader: '실행 및 대기 중인 에이전트',
    liveRaceLabel: '실시간 레이스',
    raceThinking: (count) => `${count} 생각 중`,
    raceWaiting: (count) => `${count} 대기 중`,
    raceSubagentsShort: (count) => `서브 ${count}`,
    subagentsHeader: '서브에이전트 세션',
    backgroundTasksHeader: '백그라운드 작업',
    reasoningLabel: '추론 레벨',
    reasoningNotRecorded: '—',
    clickToInspectHint: '클릭하여 I/O 보기 (터미널이 있으면 포커스)',
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
    pricingModelsLoaded: (count) => `${count}개 모델 가격 로드됨`,
    pricingModelsTooltip: '가격을 알고 있는 모델 수이며, 현재 사용 중인 모델 수가 아닙니다.',
    justNow: '방금 전',
    minutesAgo: (m) => `${m}분 전`,
    hoursAgo: (h) => `${h}시간 전`,
    daysAgo: (d) => `${d}일 전`,
    activeBadge: '활성',
    quota5hLabel: '5시간 창',
    quotaWeeklyLabel: '주간 (7d)',
    quotaUsedLabel: '사용',
    quotaResetsIn: (countdown) => `${countdown} 후 초기화`,
    quotaResetSoon: '곧 초기화',
    quotaNotApplicable: '해당 없음',
    quotaWeeklyOnlyHint: '주간 전용 플랜 · 5시간 한도 없음',
    quotaResetCredits: (count) => `리셋 크레딧 ${count}`,
    quotaNextExpiry: (when) => `만료 ${when}`,
    quotaLocalUsage5h: '로컬 5h',
    quotaLocalUsage7d: '로컬 7d',
    quotaTurnsShort: (count) => `${count} 턴`,
    quotaRateLimitsShort: (count) => `${count} × 429`,
    quotaUnavailableLabel: '공식 할당량 사용 불가',
    quotaErrorLabel: '할당량 조회 오류',
    quotaLoadingLabel: '할당량 확인 중…',
    quotaNoDataLabel: '할당량 데이터 없음',
    quotaSourceLive: '실시간 한도',
    quotaSourceCache: '캐시된 한도',
    quotaSourceLoading: '동기화 중…',
    quotaSourceError: '동기화 오류',
    quotaRefreshAction: '새로고침',
    quotaOtherAccounts: '계정 목록',
    quotaActiveAccountBadge: '활성',
    quotaStatusOk: '정상',
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
  },
  cs: {
    appTitle: 'Token Pulse',
    tabs: {
      live: 'Živý přehled',
      sessions: 'Konverzace worktree',
      day: 'Dnes',
      week: 'Tento týden',
      month: 'Tento měsíc',
      quotas: 'Kvóty a limity'
    },
    navShort: {
      live: 'Živě',
      sessions: 'Relace',
      day: 'Dnes',
      week: 'Týden',
      month: 'Měsíc',
      quotas: 'Kvóty',
      stats: 'Statistiky'
    },
    breakdownModes: {
      agent: 'Agent',
      model: 'Model',
      project: 'Projekt'
    },
    tabSubtitles: {
      live: 'Aktivní agenti, modely a živá I/O telemetrie',
      sessions: 'Relace vybraného projektu a worktree, od nejnovějších',
      day: 'Spotřeba tokenů a odhad nákladů za 24 hodin',
      week: 'Trend za posledních 7 dní a rozpad podle agentů',
      month: 'Trend za posledních 30 dní a rozpad podle agentů',
      quotas: '5hodinové a týdenní limity plánů Codex, Antigravity a Claude'
    },
    scopeAll: 'Celý počítač',
    scopeWorktree: 'Worktree',
    refreshTooltip: 'Znovu prohledat přepisy a aktuální ceny',
    syncPricingTooltip: 'Synchronizovat nejnovější oficiální ceny modelů',
    liveTpsLabel: 'ŽIVÉ TPS',
    peakLabel: 'Špička',
    avgLabel: 'Průměr',
    activeTokensLabel: 'AKTIVNÍ TOKENY',
    liveCostLabel: 'NÁKLADY AKTIVNÍCH RELACÍ',
    todayCostLabel: 'NÁKLADY DNES',
    periodCostLabel: 'ODHAD NÁKLADŮ',
    totalTokensLabel: 'TOKENY CELKEM',
    vsPrevious: 'oproti předchozímu období',
    inputShort: 'Vstup',
    cacheShort: 'Cache',
    outputShort: 'Výstup',
    costShort: 'Cena',
    runningAgentsHeader: 'AKTIVNÍ A NEDÁVNÍ AGENTI',
    liveRaceLabel: 'ŽIVÝ ZÁVOD',
    raceThinking: (count) => `${count} přemýšlí`,
    raceWaiting: (count) => `${count} čeká`,
    raceSubagentsShort: (count) => `${count} sub`,
    subagentsHeader: 'RELACE SUBAGENTŮ',
    backgroundTasksHeader: 'ÚLOHY NA POZADÍ',
    reasoningLabel: 'ÚROVEŇ ODVOZOVÁNÍ',
    reasoningNotRecorded: '—',
    clickToInspectHint: 'Kliknutím zobrazíte I/O; pokud je k dispozici terminál, přepne se na něj',
    outputStreamLabel: 'VÝSTUP MODELU · RYCHLOST ODPOVĚDI',
    inputStreamLabel: 'VSTUP MODELU · RYCHLOST KONTEXTU',
    live1sBadge: '1s ŽIVĚ',
    noLiveAgents: 'Momentálně nejsou aktivní žádné relace agentů',
    noSessionsInWorktree: 'V tomto worktree projektu zatím nejsou žádné konverzace',
    noPeriodData: 'V tomto období nebyla zaznamenána žádná spotřeba tokenů',
    sessionsCountSuffix: 'konverzací',
    sortedNewestHint: 'Seřazeno od nejnovějších',
    worktreePrefix: 'Projekt / Worktree',
    allWorkspacesFallback: 'Všechny pracovní prostory',
    chartHourHeader: 'DNES PO HODINÁCH (00:00–24:00)',
    chartWeekHeader: 'POSLEDNÍCH 7 DNÍ',
    chartMonthHeader: 'POSLEDNÍCH 30 DNÍ',
    byAgentHeader: 'PODLE AGENTA · TOKENY, NÁKLADY A TPS',
    pricingOnline: 'Aktuální online ceny',
    pricingCached: 'Ceny z cache',
    pricingBuiltin: 'Základní ceny',
    pricingModelsLoaded: (count) => `Načteno cen modelů: ${count}`,
    pricingModelsTooltip: 'Počet modelů se známou cenou, nikoli počet aktuálně používaných modelů.',
    justNow: 'Právě teď',
    minutesAgo: (m) => `před ${m} min`,
    hoursAgo: (h) => `před ${h} h`,
    daysAgo: (d) => `před ${d} d`,
    activeBadge: 'aktivní',
    quota5hLabel: '5h okno',
    quotaWeeklyLabel: 'Týdenní (7d)',
    quotaUsedLabel: 'využito',
    quotaResetsIn: (countdown) => `Reset za ${countdown}`,
    quotaResetSoon: 'Brzy se resetuje',
    quotaNotApplicable: 'Neuplatňuje se',
    quotaWeeklyOnlyHint: 'Pouze týdenní plán · bez 5h limitu',
    quotaResetCredits: (count) => `Resetovacích kreditů: ${count}`,
    quotaNextExpiry: (when) => `vyprší ${when}`,
    quotaLocalUsage5h: 'Lokálně 5h',
    quotaLocalUsage7d: 'Lokálně 7d',
    quotaTurnsShort: (count) => `${count} kol`,
    quotaRateLimitsShort: (count) => `${count} × 429`,
    quotaUnavailableLabel: 'Oficiální kvóta není dostupná',
    quotaErrorLabel: 'Kontrola kvóty selhala',
    quotaLoadingLabel: 'Zjišťuji kvóty poskytovatelů…',
    quotaNoDataLabel: 'Data o kvótách zatím nejsou načtena',
    quotaSourceLive: 'Živé kvóty',
    quotaSourceCache: 'Kvóty z cache',
    quotaSourceLoading: 'Synchronizuji kvóty…',
    quotaSourceError: 'Chyba synchronizace kvót',
    quotaRefreshAction: 'Obnovit',
    quotaOtherAccounts: 'Účty',
    quotaActiveAccountBadge: 'aktivní',
    quotaStatusOk: 'OK',
    states: {
      working: 'pracuje',
      waiting: 'čeká',
      blocked: 'blokováno',
      done: 'hotovo'
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
  if (tag === 'cs' || tag.startsWith('cs-') || tag.startsWith('cs_')) return 'cs'
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

export function formatDurationSpan(diffMs: number): string {
  if (!Number.isFinite(diffMs) || diffMs <= 0) return ''
  if (diffMs <= 60_000) return '<1m'
  const totalMins = Math.floor(diffMs / 60_000)
  const days = Math.floor(totalMins / (60 * 24))
  const hours = Math.floor((totalMins % (60 * 24)) / 60)
  const mins = totalMins % 60
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }
  return `${mins}m`
}

export function formatElapsedDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return '0s'
  const totalSec = Math.floor(elapsedMs / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const hours = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  return `${mins}m ${secs}s`
}

export function formatCountdown(
  targetMs: number | null | undefined,
  nowMs: number,
  msg: UiMessages
): string {
  if (!targetMs || !Number.isFinite(targetMs)) return ''
  const diffMs = targetMs - nowMs
  if (diffMs <= 60_000) return msg.quotaResetSoon
  return msg.quotaResetsIn(formatDurationSpan(diffMs))
}
