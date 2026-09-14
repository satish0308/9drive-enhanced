import { useState } from 'react'
import { ArrowRightLeft, CheckCircle2, HardDrive, Loader2, AlertCircle } from 'lucide-react'
import { DummyModal } from './DummyModal'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/api'

export type ConnectedAccountInfo = {
  id: string
  provider: string
  email: string
  displayName?: string | null
  color?: string | null
  status: string
  fileCount?: number
  folderCount?: number
  storageAccount?: {
    totalBytes?: string | null
    usedBytes?: string | null
    availableBytes?: string | null
  } | null
}

type TransferModalProps = {
  open: boolean
  onClose: () => void
  onConfirm: (targetAccountId: string) => Promise<void>
  title: string
  description?: string
  accounts: ConnectedAccountInfo[]
  currentAccountId?: string
  transferring: boolean
  itemSummary: string
}

export function TransferModal({
  open,
  onClose,
  onConfirm,
  title,
  description = 'Stream and migrate data directly to another connected Google Drive or S3 account.',
  accounts,
  currentAccountId,
  transferring,
  itemSummary,
}: TransferModalProps) {
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [error, setError] = useState('')

  const availableAccounts = accounts.filter(
    (acc) => acc.status === 'connected' && acc.id !== currentAccountId
  )

  const activeTargetId = selectedAccountId || availableAccounts[0]?.id || ''

  async function handleTransfer() {
    if (!activeTargetId) {
      setError('Please select a target storage account.')
      return
    }
    setError('')
    try {
      await onConfirm(activeTargetId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed')
    }
  }

  return (
    <DummyModal open={open} title={title} description={description} onClose={onClose}>
      <div className="space-y-4">
        {/* Item to transfer summary */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-800/40">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Item to Transfer</p>
          <p className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-200 break-all">{itemSummary}</p>
        </div>

        {/* Target account selector */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            Target Storage Account
          </label>
          {availableAccounts.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>No other storage account is connected. Connect another Google Drive in Settings first.</span>
            </div>
          ) : (
            <div className="space-y-2">
              {availableAccounts.map((account) => {
                const isSelected = activeTargetId === account.id
                const providerLabel = account.provider === 's3' ? 'S3 Storage' : 'Google Drive'
                const freeBytes = account.storageAccount?.availableBytes
                  ? formatBytes(account.storageAccount.availableBytes)
                  : 'unlimited'

                return (
                  <button
                    key={account.id}
                    type="button"
                    disabled={transferring}
                    onClick={() => setSelectedAccountId(account.id)}
                    className={[
                      'flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all',
                      isSelected
                        ? 'border-blue-600 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-950/40 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300 bg-white dark:border-slate-800 dark:bg-slate-800/60',
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        <HardDrive className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">
                          {account.email || account.displayName || account.id}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {providerLabel} • <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{freeBytes} free</span>
                        </p>
                      </div>
                    </div>
                    {isSelected ? (
                      <CheckCircle2 className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
                    ) : (
                      <div className="h-5 w-5 rounded-full border border-slate-300 dark:border-slate-600 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Transfer Warning / Notice */}
        <p className="text-xs text-slate-500 leading-relaxed dark:text-slate-400">
          The backend will stream data directly from the source to the target storage account. Once verified, it will be cleaned up from the original drive.
        </p>

        {error ? (
          <div className="flex items-center gap-2 rounded-xl bg-red-50 p-3 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="outline" disabled={transferring} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={transferring || availableAccounts.length === 0}
            onClick={handleTransfer}
            className="gap-2"
          >
            {transferring ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Transferring...
              </>
            ) : (
              <>
                <ArrowRightLeft className="h-4 w-4" />
                Start Transfer
              </>
            )}
          </Button>
        </div>
      </div>
    </DummyModal>
  )
}
