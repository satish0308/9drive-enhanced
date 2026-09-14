import { useState } from 'react'
import { HardDrive, Palette, Check, ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getAccountColor } from './AccountColorPickerModal'
import type { ConnectedAccountInfo } from './TransferModal'

type DriveSelectorBarProps = {
  accounts: ConnectedAccountInfo[]
  enabledAccountIds: Set<string>
  onToggleAccount: (accountId: string) => void
  onEnableAllAccounts: () => void
  onOnlyAccount?: (accountId: string) => void
  onChangeAccountColor: (account: ConnectedAccountInfo) => void
  visible?: boolean
  onToggleVisible?: () => void
  folderCountByAccount?: Record<string, number>
  fileCountByAccount?: Record<string, number>
}

export function DriveSelectorBar({
  accounts,
  enabledAccountIds,
  onToggleAccount,
  onEnableAllAccounts,
  onOnlyAccount,
  onChangeAccountColor,
  onToggleVisible,
  folderCountByAccount = {},
  fileCountByAccount = {},
}: DriveSelectorBarProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (accounts.length === 0) return null

  const allSelected = accounts.every((a) => enabledAccountIds.has(a.id))

  return (
    <div className="mt-4 rounded-2xl border border-slate-200/80 bg-white/80 backdrop-blur-md p-3.5 shadow-sm dark:bg-slate-900/60 dark:border-slate-800 transition-all">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
            <HardDrive className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              Connected Drives
              <span className="text-[11px] font-normal text-slate-500">
                ({enabledAccountIds.size}/{accounts.length} active)
              </span>
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 text-slate-600 dark:text-slate-400"
            onClick={onEnableAllAccounts}
            disabled={allSelected}
          >
            Select All
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 text-slate-500"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand drive grid' : 'Collapse drive grid'}
          >
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </Button>

          {onToggleVisible && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              onClick={onToggleVisible}
              title="Hide connected drives bar"
              aria-label="Hide connected drives bar"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          {/* "All Drives" quick pill */}
          <button
            type="button"
            onClick={onEnableAllAccounts}
            className={`group inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold border transition-all ${
              allSelected
                ? 'border-blue-600 bg-blue-50 text-blue-700 shadow-sm dark:bg-blue-950 dark:text-blue-300 dark:border-blue-500'
                : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400'
            }`}
          >
            <span
              className={`flex h-2.5 w-2.5 rounded-full ${
                allSelected ? 'bg-blue-600 ring-2 ring-blue-400/40' : 'bg-slate-300'
              }`}
            />
            <span>All Drives</span>
            <span className="ml-1 rounded-md bg-white/80 px-1.5 py-0.2 text-[10px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {accounts.length}
            </span>
          </button>

          {/* Account Pills */}
          {accounts.map((account, idx) => {
            const isEnabled = enabledAccountIds.has(account.id)
            const color = getAccountColor(account, idx)
            const fCount = account.folderCount ?? folderCountByAccount[account.id] ?? 0
            const fileCount = account.fileCount ?? fileCountByAccount[account.id] ?? 0

            return (
              <div
                key={account.id}
                className={`group relative flex items-center rounded-xl border transition-all ${
                  isEnabled
                    ? 'shadow-sm bg-white dark:bg-slate-800/80'
                    : 'opacity-50 bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800'
                }`}
                style={{
                  borderColor: isEnabled ? `${color}50` : undefined,
                  boxShadow: isEnabled ? `0 1px 3px ${color}15` : undefined,
                }}
              >
                {/* Click area to toggle enable / disable */}
                <button
                  type="button"
                  onClick={() => onToggleAccount(account.id)}
                  className="flex items-center gap-2.5 py-1.5 pl-3 pr-2 text-left cursor-pointer"
                  title={isEnabled ? `Click to hide items from ${account.email}` : `Click to show items from ${account.email}`}
                >
                  <span
                    className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full transition-transform group-hover:scale-110"
                    style={{ backgroundColor: color }}
                  >
                    {isEnabled ? (
                      <Check className="h-2 w-2 text-white stroke-[3]" />
                    ) : null}
                  </span>

                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="truncate text-xs font-bold"
                        style={{ color: isEnabled ? color : undefined }}
                      >
                        {account.displayName || account.email.split('@')[0]}
                      </span>
                      <span className="hidden sm:inline-block text-[11px] text-slate-400 truncate max-w-[130px]">
                        ({account.email})
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span>{fCount} folders</span>
                      <span>•</span>
                      <span>{fileCount} files</span>
                      {!isEnabled && (
                        <span className="ml-1 font-bold text-amber-600 bg-amber-50 px-1 rounded text-[9px]">
                          Hidden
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                {/* Only Drive Button */}
                {onOnlyAccount && accounts.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOnlyAccount(account.id)
                    }}
                    className="mr-1 hidden group-hover:inline-flex items-center text-[10px] font-bold text-blue-600 hover:text-blue-800 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60 px-1.5 py-0.5 rounded-md transition-colors"
                    title={`Show only ${account.email}`}
                  >
                    only
                  </button>
                )}

                {/* Account Color Palette Button */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onChangeAccountColor(account)
                  }}
                  className="mr-1.5 flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  title={`Change folder color for ${account.email}`}
                  aria-label={`Change folder color for ${account.email}`}
                >
                  <Palette className="h-3.5 w-3.5" style={{ color }} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
