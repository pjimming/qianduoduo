import type { StrategyHoldingRow, StrategyWorkspace } from '@/types/r2-strategy'

const exitMarks = {
  exit_required: { label: '准备退出', tone: 'danger' },
  exit_at_open: { label: '到期复核退出', tone: 'warning' },
  exit_rules_pending: { label: '赎回窗口待核', tone: 'warning' },
} as const

const pendingMark = { label: '退出条件待核', tone: 'pending' } as const

export function currentStrategySnapshot(workspace: StrategyWorkspace): boolean {
  const input = workspace.result?.input
  return workspace.contract_matches !== false && !workspace.stale &&
    input?.activation_seq === workspace.activation_seq && input.mode === workspace.mode &&
    input.business_date === workspace.business_date
}

export function holdingExitMark(row?: StrategyHoldingRow) {
  if (row?.exit_conditions?.status === 'pending') return pendingMark
  if (row?.exit_conditions?.status !== 'met') return undefined
  if (Object.hasOwn(exitMarks, row.state)) return exitMarks[row.state as keyof typeof exitMarks]
}
