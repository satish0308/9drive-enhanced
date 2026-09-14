import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  CloudDownload,
  Folder,
  HardDrive,
  Loader2,
  RefreshCw,
  FileText,
  AlertCircle,
  ChevronRight
} from 'lucide-react'
import { DummyModal } from './DummyModal'
import { Button } from '@/components/ui/button'
import { apiFetch, formatBytes } from '@/lib/api'
import type { ConnectedAccountInfo } from './TransferModal'

type DriveBrowseItem = {
  id: string
  name: string
  mimeType: string
  sizeBytes: string
  isFolder: boolean
  modifiedTime?: string | null
  iconLink?: string | null
  isImported: boolean
}

type DriveBrowseResult = {
  currentFolder: {
    id: string
    name: string
    parentFolderId: string | null
  }
  items: DriveBrowseItem[]
}

type GoogleDriveImportModalProps = {
  open: boolean
  onClose: () => void
  accounts: ConnectedAccountInfo[]
  onImportSuccess: () => Promise<void>
}

export function GoogleDriveImportModal({
  open,
  onClose,
  accounts,
  onImportSuccess,
}: GoogleDriveImportModalProps) {
  const googleAccounts = accounts.filter(
    (acc) => acc.provider === 'google_drive' && acc.status === 'connected'
  )

  const [selectedAccountId, setSelectedAccountId] = useState(googleAccounts[0]?.id || '')
  const [currentFolderId, setCurrentFolderId] = useState('root')
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([
    { id: 'root', name: 'My Drive' },
  ])
  const [browseData, setBrowseData] = useState<DriveBrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'quick' | 'browse'>('quick')

  const activeAccount = googleAccounts.find((a) => a.id === selectedAccountId) || googleAccounts[0]

  useEffect(() => {
    if (open && googleAccounts.length > 0 && !selectedAccountId) {
      setSelectedAccountId(googleAccounts[0].id)
    }
  }, [open, googleAccounts, selectedAccountId])

  useEffect(() => {
    if (!open || !activeAccount) return
    loadDriveContents(currentFolderId)
  }, [open, activeAccount?.id, currentFolderId])

  async function loadDriveContents(folderId: string) {
    if (!activeAccount) return
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch<DriveBrowseResult>(
        `/connected-accounts/${activeAccount.id}/drive/browse?folderId=${folderId}`
      )
      setBrowseData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse Google Drive')
    } finally {
      setLoading(false)
    }
  }

  function handleNavigateFolder(folderId: string, folderName: string) {
    setCurrentFolderId(folderId)
    setSelectedItemIds(new Set())
    setBreadcrumbs((prev) => {
      const index = prev.findIndex((b) => b.id === folderId)
      if (index >= 0) return prev.slice(0, index + 1)
      return [...prev, { id: folderId, name: folderName }]
    })
  }

  function handleBack() {
    if (breadcrumbs.length <= 1) return
    const nextBreadcrumbs = [...breadcrumbs]
    nextBreadcrumbs.pop()
    const target = nextBreadcrumbs[nextBreadcrumbs.length - 1]
    setBreadcrumbs(nextBreadcrumbs)
    setCurrentFolderId(target.id)
    setSelectedItemIds(new Set())
  }

  function toggleItemSelection(id: string) {
    setSelectedItemIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (!browseData) return
    const unimported = browseData.items.filter((i) => !i.isImported)
    const allSelected = unimported.length > 0 && unimported.every((i) => selectedItemIds.has(i.id))
    if (allSelected) {
      setSelectedItemIds(new Set())
    } else {
      setSelectedItemIds(new Set(unimported.map((i) => i.id)))
    }
  }

  async function handleImportSelected() {
    if (!activeAccount || !browseData || selectedItemIds.size === 0) return
    setImporting(true)
    setError('')
    setMessage('')
    try {
      const folderIds = browseData.items
        .filter((i) => i.isFolder && selectedItemIds.has(i.id))
        .map((i) => i.id)
      const fileIds = browseData.items
        .filter((i) => !i.isFolder && selectedItemIds.has(i.id))
        .map((i) => i.id)

      const result = await apiFetch<{ importedFoldersCount: number; importedFilesCount: number }>(
        `/connected-accounts/${activeAccount.id}/drive/import`,
        {
          method: 'POST',
          body: JSON.stringify({ folderIds, fileIds }),
        }
      )

      setMessage(`Imported ${result.importedFoldersCount} folder(s) and ${result.importedFilesCount} file(s).`)
      setSelectedItemIds(new Set())
      await onImportSuccess()
      await loadDriveContents(currentFolderId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  async function handleImportAll() {
    if (!activeAccount) return
    setImporting(true)
    setError('')
    setMessage('')
    try {
      const result = await apiFetch<{ importedFoldersCount: number; importedFilesCount: number }>(
        `/connected-accounts/${activeAccount.id}/drive/import-all`,
        { method: 'POST', body: JSON.stringify({}) }
      )
      setMessage(
        `Full drive sync complete: imported ${result.importedFoldersCount} folder(s) and ${result.importedFilesCount} file(s).`
      )
      await onImportSuccess()
      await loadDriveContents(currentFolderId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Full import failed')
    } finally {
      setImporting(false)
    }
  }

  return (
    <DummyModal
      open={open}
      title="Import from Google Drive"
      description="Discover and import existing folders and files directly into 9Drive."
      onClose={onClose}
      className="sm:max-w-2xl"
    >
      <div className="space-y-4">
        {/* Account Selector */}
        {googleAccounts.length > 1 ? (
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Google Drive Account
            </label>
            <select
              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold dark:border-slate-800 dark:bg-slate-800"
              value={activeAccount?.id || ''}
              onChange={(e) => {
                setSelectedAccountId(e.target.value)
                setCurrentFolderId('root')
                setBreadcrumbs([{ id: 'root', name: 'My Drive' }])
                setSelectedItemIds(new Set())
              }}
              disabled={importing}
            >
              {googleAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.email || acc.displayName || acc.id}
                </option>
              ))}
            </select>
          </div>
        ) : activeAccount ? (
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            <HardDrive className="h-4 w-4 text-blue-600" />
            <span>Scanning Account: <b className="text-slate-900 dark:text-slate-100">{activeAccount.email}</b></span>
          </div>
        ) : (
          <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-700">
            No connected Google Drive accounts found. Connect one in Settings first.
          </div>
        )}

        {/* Tab Switcher */}
        <div className="flex rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-800/60">
          <button
            type="button"
            onClick={() => setActiveTab('quick')}
            className={[
              'flex-1 rounded-lg py-1.5 text-xs font-bold transition-all',
              activeTab === 'quick'
                ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-900 dark:text-blue-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400',
            ].join(' ')}
          >
            Quick Auto-Import (All)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('browse')}
            className={[
              'flex-1 rounded-lg py-1.5 text-xs font-bold transition-all',
              activeTab === 'browse'
                ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-900 dark:text-blue-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400',
            ].join(' ')}
          >
            Browse & Select Folders
          </button>
        </div>

        {/* Tab 1: Quick Auto-Import */}
        {activeTab === 'quick' && (
          <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-5 dark:border-slate-800 dark:bg-slate-800/30">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400">
                <CloudDownload className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-sm font-extrabold text-slate-900 dark:text-slate-100">
                  Import All Google Drive Folders & Files
                </h4>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed dark:text-slate-400">
                  This scans your Google Drive root directory, creates matching folders in 9Drive, and indexes all your files so they show up immediately on your dashboard.
                </p>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <Button
                type="button"
                disabled={importing || !activeAccount}
                onClick={handleImportAll}
                className="gap-2"
              >
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Importing Drive Data...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4" />
                    Scan & Import All Folders & Files
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Tab 2: Browse & Select */}
        {activeTab === 'browse' && (
          <div className="space-y-2">
            {/* Breadcrumb row */}
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2 dark:border-slate-800">
              <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-semibold text-slate-600 dark:text-slate-300">
                {breadcrumbs.length > 1 && (
                  <button
                    type="button"
                    onClick={handleBack}
                    className="mr-1 rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800"
                    title="Go back"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </button>
                )}
                {breadcrumbs.map((crumb, idx) => (
                  <span key={crumb.id} className="flex items-center gap-1">
                    {idx > 0 && <ChevronRight className="h-3 w-3 text-slate-400" />}
                    <button
                      type="button"
                      disabled={idx === breadcrumbs.length - 1}
                      onClick={() => handleNavigateFolder(crumb.id, crumb.name)}
                      className={
                        idx === breadcrumbs.length - 1
                          ? 'font-bold text-slate-900 dark:text-slate-100'
                          : 'hover:underline text-blue-600 dark:text-blue-400'
                      }
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </div>

              {browseData && browseData.items.filter((i) => !i.isImported).length > 0 && (
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="shrink-0 text-xs font-bold text-blue-600 hover:underline dark:text-blue-400"
                >
                  {browseData.items.filter((i) => !i.isImported).every((i) => selectedItemIds.has(i.id))
                    ? 'Deselect All'
                    : 'Select All Unimported'}
                </button>
              )}
            </div>

            {/* Folder & Files List */}
            <div className="max-h-72 min-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900/50">
              {loading ? (
                <div className="flex h-48 items-center justify-center gap-2 text-xs text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>Loading Google Drive contents...</span>
                </div>
              ) : !browseData || browseData.items.length === 0 ? (
                <div className="flex h-48 items-center justify-center text-xs text-slate-400">
                  No files or folders found in this directory.
                </div>
              ) : (
                <div className="space-y-1">
                  {browseData.items.map((item) => {
                    const isSelected = selectedItemIds.has(item.id)
                    return (
                      <div
                        key={item.id}
                        className={[
                          'flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 transition-all text-xs',
                          item.isImported
                            ? 'bg-slate-50 text-slate-400 dark:bg-slate-800/30'
                            : isSelected
                            ? 'bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200'
                            : 'hover:bg-slate-50 text-slate-800 dark:hover:bg-slate-800/60 dark:text-slate-200',
                        ].join(' ')}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <input
                            type="checkbox"
                            disabled={item.isImported || importing}
                            checked={item.isImported || isSelected}
                            onChange={() => toggleItemSelection(item.id)}
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                          {item.isFolder ? (
                            <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                          ) : (
                            <FileText className="h-4 w-4 text-blue-500 shrink-0" />
                          )}
                          {item.isFolder ? (
                            <button
                              type="button"
                              onClick={() => handleNavigateFolder(item.id, item.name)}
                              className="font-bold hover:underline truncate text-left"
                            >
                              {item.name}
                            </button>
                          ) : (
                            <span className="truncate font-medium">{item.name}</span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {item.isFolder ? (
                            <button
                              type="button"
                              onClick={() => handleNavigateFolder(item.id, item.name)}
                              className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                            >
                              Browse &rarr;
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-400">
                              {formatBytes(item.sizeBytes)}
                            </span>
                          )}

                          {item.isImported && (
                            <span className="flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              Imported
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Bottom Actions for Browse Tab */}
            <div className="pt-2 flex justify-between items-center">
              <span className="text-xs font-semibold text-slate-500">
                {selectedItemIds.size} item(s) selected
              </span>
              <Button
                type="button"
                disabled={importing || selectedItemIds.size === 0}
                onClick={handleImportSelected}
                className="gap-2"
              >
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <CloudDownload className="h-4 w-4" />
                    Import Selected ({selectedItemIds.size})
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Message feedback */}
        {message ? (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{message}</span>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-center gap-2 rounded-xl bg-red-50 p-3 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Close button */}
        <div className="flex justify-end pt-2">
          <Button variant="outline" disabled={importing} onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </DummyModal>
  )
}
