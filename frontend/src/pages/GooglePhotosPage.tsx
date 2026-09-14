import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Images,
  Image as ImageIcon,
  Video,
  Copy,
  Move,
  ArrowRight,
  FolderPlus,
  Check,
  CheckSquare,
  Square,
  Download,
  Info,
  X,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Sparkles,
  RefreshCw,
  Search,
  Camera,
  Play,
  Loader2,
  HardDrive,
  Cloud,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'
import { apiFetch, formatBytes, formatDate, API_URL } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface PhotoItem {
  id: string
  name: string
  mimeType: string
  sizeBytes: string
  checksum: string | null
  createdAt: string
  updatedAt: string
  folderId: string | null
  provider: string
  providerFileId: string
  connectedAccount: {
    id: string
    email: string
    provider: string
    color: string | null
    displayName: string | null
  }
  folder: {
    id: string
    name: string
  } | null
  thumbnailUrl: string
  streamUrl: string
}

export interface PhotoDetails {
  file: PhotoItem
  dimensions?: { width: number; height: number; rotation?: number }
  camera?: {
    make?: string
    model?: string
    focalLength?: number
    aperture?: number
    iso?: number
    exposureTime?: number
  }
  video?: {
    fps?: number
    durationMillis?: string
  }
  createdTime?: string
  modifiedTime?: string
  thumbnailUrl?: string
}

export interface ConnectedAccountOption {
  id: string
  email: string
  provider: string
  displayName?: string
  color?: string
  storageAccount?: {
    totalBytes: string | null
    usedBytes: string
    availableBytes: string | null
  } | null
}

export interface AccountPhotosStatus {
  id: string
  email: string
  displayName?: string
  color?: string
  hasPhotosScope: boolean
}

export function GooglePhotosPage() {
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [totalPhotos, setTotalPhotos] = useState(0)
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<ConnectedAccountOption[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all')
  const [mediaType, setMediaType] = useState<'all' | 'image' | 'video'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Lightbox / Viewer
  const [viewerPhoto, setViewerPhoto] = useState<PhotoItem | null>(null)
  const [photoDetails, setPhotoDetails] = useState<PhotoDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [showInfoSidebar, setShowInfoSidebar] = useState(false)

  // Transfer Modal (Drive to Drive)
  const [transferModalOpen, setTransferModalOpen] = useState(false)
  const [transferMode, setTransferMode] = useState<'copy' | 'move'>('copy')
  const [targetAccountId, setTargetAccountId] = useState<string>('')
  const [targetFolderId, setTargetFolderId] = useState<string>('root')
  const [targetFolders, setTargetFolders] = useState<{
    dbFolders: Array<{ id: string; name: string }>
    driveFolders: Array<{ id: string; name: string }>
  }>({ dbFolders: [], driveFolders: [] })
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [transferProgress, setTransferProgress] = useState<{
    running: boolean
    current: number
    total: number
    results: Array<{ fileName: string; success: boolean; error?: string; checksum?: string }>
    completed: boolean
  } | null>(null)
  const token = getAccessToken() || ''

  // Google Photos Cloud status & banner
  const [accountStatuses, setAccountStatuses] = useState<AccountPhotosStatus[]>([])
  const [dismissCloudBanner, setDismissCloudBanner] = useState(false)
  const [connectingGoogle, setConnectingGoogle] = useState(false)
  const [connectionSuccess, setConnectionSuccess] = useState<string | null>(null)

  // Google Photos Cloud Picker Modal
  const [pickerModalOpen, setPickerModalOpen] = useState(false)
  const [pickerStep, setPickerStep] = useState<
    'permission_needed' | 'api_disabled' | 'opening' | 'polling' | 'ready_to_import' | 'importing' | 'completed' | 'error'
  >('opening')
  const [pickerActivationUrl, setPickerActivationUrl] = useState<string>(
    'https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview?project=866882368661'
  )
  const [pickerAccountId, setPickerAccountId] = useState<string>('')
  const [pickerSessionId, setPickerSessionId] = useState<string | null>(null)
  const [pickerUri, setPickerUri] = useState<string | null>(null)
  const [pickedItems, setPickedItems] = useState<Array<{ id: string; baseUrl: string; name: string; mimeType: string }>>([])
  const [pickerTargetAccountId, setPickerTargetAccountId] = useState<string>('')
  const [pickerTargetFolderId, setPickerTargetFolderId] = useState<string>('root')
  const [pickerNewFolderName, setPickerNewFolderName] = useState('')
  const [pickerCreatingFolder, setPickerCreatingFolder] = useState(false)
  const [pickerFolders, setPickerFolders] = useState<{
    dbFolders: Array<{ id: string; name: string }>
    driveFolders: Array<{ id: string; name: string }>
  }>({ dbFolders: [], driveFolders: [] })
  const [pickerFoldersLoading, setPickerFoldersLoading] = useState(false)
  const [importResults, setImportResults] = useState<{
    importedCount: number
    failedCount: number
    results: Array<{ name: string; success: boolean; error?: string; checksum?: string }>
  } | null>(null)
  const [pickerErrorMsg, setPickerErrorMsg] = useState<string | null>(null)

  // Load connected accounts
  useEffect(() => {
    apiFetch<{ accounts: ConnectedAccountOption[] }>('/connected-accounts')
      .then((data) => {
        const googleAccounts = data.accounts.filter((a) => a.provider === 'google_drive')
        setAccounts(googleAccounts)
        if (googleAccounts.length > 0 && !targetAccountId) {
          setTargetAccountId(googleAccounts[0].id)
        }
      })
      .catch((err) => console.error('Failed to load accounts:', err))
  }, [])

  // Load photos
  const fetchPhotos = async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({
        page: String(page),
        limit: '60',
        mediaType,
      })
      if (selectedAccountId !== 'all') {
        query.set('accountId', selectedAccountId)
      }
      if (searchQuery.trim()) {
        query.set('search', searchQuery.trim())
      }

      const data = await apiFetch<{
        total: number
        page: number
        limit: number
        totalPages: number
        photos: PhotoItem[]
      }>(`/photos?${query.toString()}`)

      setPhotos(data.photos || [])
      setTotalPhotos(data.total || 0)
      setTotalPages(data.totalPages || 1)
    } catch (err) {
      console.error('Failed to fetch photos:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPhotos()
  }, [page, selectedAccountId, mediaType])

  // Fetch accounts Google Photos permission statuses
  const fetchAccountStatuses = async () => {
    try {
      const data = await apiFetch<{ accounts: AccountPhotosStatus[] }>('/photos/accounts-status')
      setAccountStatuses(data.accounts || [])
    } catch (err) {
      console.error('Failed to fetch accounts photo status:', err)
    }
  }

  useEffect(() => {
    fetchAccountStatuses()
  }, [])

  const accountsWithPhotosAccess = useMemo(() => {
    return accountStatuses.filter((a) => a.hasPhotosScope)
  }, [accountStatuses])

  const accountsNeedingPhotosAccess = useMemo(() => {
    return accountStatuses.filter((a) => !a.hasPhotosScope)
  }, [accountStatuses])



  // OAuth connect for granting Google Photos scope
  const handleConnectPhotos = async () => {
    setConnectingGoogle(true)
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      const popup = window.open(data.url, 'google_oauth_connect', 'width=600,height=700')
      const handleMsg = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return
        if (e.data?.type === 'GOOGLE_CONNECTED') {
          window.removeEventListener('message', handleMsg)
          setConnectionSuccess('Google Photos access granted successfully!')
          setTimeout(() => setConnectionSuccess(null), 6000)
          fetchAccountStatuses()
          fetchPhotos()
          setConnectingGoogle(false)
          if (pickerStep === 'permission_needed') {
            startPickerSession(pickerAccountId)
          }
        }
      }
      window.addEventListener('message', handleMsg)
      const timer = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(timer)
          window.removeEventListener('message', handleMsg)
          fetchAccountStatuses()
          fetchPhotos()
          setConnectingGoogle(false)
          if (pickerStep === 'permission_needed') {
            startPickerSession(pickerAccountId)
          }
        }
      }, 1000)
    } catch (err: any) {
      alert(`Failed to start Google connection: ${err.message}`)
      setConnectingGoogle(false)
    }
  }

  // Google Photos Picker: Launch Session
  const handleOpenGooglePhotosPicker = (preferredAccountId?: string) => {
    const accWithPhotos = accounts.find((a) => accountStatuses.some((st) => st.id === a.id && st.hasPhotosScope))
    const accId = preferredAccountId || (selectedAccountId !== 'all' ? selectedAccountId : accWithPhotos?.id || accounts[0]?.id)
    if (!accId) {
      alert('No connected Google accounts found.')
      return
    }
    setPickerAccountId(accId)
    const otherAcc = accounts.find((a) => a.id !== accId) || accounts[0]
    if (otherAcc) {
      setPickerTargetAccountId(otherAcc.id)
    }
    setPickerModalOpen(true)
    setPickedItems([])
    setImportResults(null)
    setPickerErrorMsg(null)

    const status = accountStatuses.find((a) => a.id === accId)
    if (status && !status.hasPhotosScope) {
      setPickerStep('permission_needed')
    } else {
      startPickerSession(accId)
    }
  }

  const startPickerSession = async (accountToUse: string) => {
    setPickerStep('opening')
    setPickerErrorMsg(null)
    try {
      const session = await apiFetch<{ sessionId: string; pickerUri: string }>('/photos/picker/session', {
        method: 'POST',
        body: JSON.stringify({ accountId: accountToUse }),
      })
      setPickerSessionId(session.sessionId)
      setPickerUri(session.pickerUri)
      window.open(session.pickerUri, 'google_photos_picker', 'width=1024,height=768')
      setPickerStep('polling')
    } catch (err: any) {
      const msg = err.message || 'Failed to start Google Photos Picker session.'
      if (
        msg.includes('GOOGLE_PHOTOS_PICKER_API_DISABLED') ||
        msg.includes('SERVICE_DISABLED') ||
        msg.includes('has not been used in project') ||
        msg.includes('is disabled')
      ) {
        const urlMatch = msg.match(/https:\/\/console\.developers\.google\.com[^\s]+/)
        if (urlMatch) {
          setPickerActivationUrl(urlMatch[0])
        }
        setPickerErrorMsg(msg)
        setPickerStep('api_disabled')
      } else if (msg.includes('SCOPE_INSUFFICIENT') || msg.includes('insufficient authentication scopes')) {
        setPickerStep('permission_needed')
      } else {
        setPickerErrorMsg(msg)
        setPickerStep('error')
      }
    }
  }

  // Polling for Picker Session completion
  useEffect(() => {
    if (!pickerModalOpen || pickerStep !== 'polling' || !pickerSessionId || !pickerAccountId) return

    let isMounted = true
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch<{
          mediaItemsSet: boolean
          items: Array<{ id: string; baseUrl: string; name: string; mimeType: string }>
        }>(`/photos/picker/session/${pickerSessionId}?accountId=${pickerAccountId}`)

        if (!isMounted) return

        if (res.mediaItemsSet) {
          clearInterval(interval)
          if (res.items && res.items.length > 0) {
            setPickedItems(res.items)
            setPickerStep('ready_to_import')
          } else {
            setPickerErrorMsg('No items were selected in the Google Photos window.')
            setPickerStep('error')
          }
        }
      } catch (err: any) {
        console.warn('Polling picker session error:', err)
      }
    }, 2500)

    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [pickerModalOpen, pickerStep, pickerSessionId, pickerAccountId])

  // Load target folders whenever pickerTargetAccountId changes
  useEffect(() => {
    if (!pickerTargetAccountId || !pickerModalOpen) return
    setPickerFoldersLoading(true)
    apiFetch<{
      dbFolders: Array<{ id: string; name: string }>
      driveFolders: Array<{ id: string; name: string }>
    }>(`/photos/target-folders/${pickerTargetAccountId}`)
      .then((data) => {
        setPickerFolders({
          dbFolders: data.dbFolders || [],
          driveFolders: data.driveFolders || [],
        })
      })
      .catch((err) => console.error('Failed to fetch picker target folders:', err))
      .finally(() => setPickerFoldersLoading(false))
  }, [pickerTargetAccountId, pickerModalOpen])

  const handleCreatePickerFolder = async () => {
    if (!pickerNewFolderName.trim() || !pickerTargetAccountId) return
    setPickerCreatingFolder(true)
    try {
      const data = await apiFetch<{ folder: { id: string; name: string } }>('/photos/target-folders', {
        method: 'POST',
        body: JSON.stringify({
          accountId: pickerTargetAccountId,
          name: pickerNewFolderName.trim(),
        }),
      })
      setPickerFolders((prev) => ({
        ...prev,
        dbFolders: [data.folder, ...prev.dbFolders],
      }))
      setPickerTargetFolderId(data.folder.id)
      setPickerNewFolderName('')
    } catch (err: any) {
      alert(`Failed to create folder: ${err.message}`)
    } finally {
      setPickerCreatingFolder(false)
    }
  }

  const handleStartPickerImport = async () => {
    if (pickedItems.length === 0 || !pickerAccountId || !pickerTargetAccountId) return
    setPickerStep('importing')
    try {
      const data = await apiFetch<{
        importedCount: number
        failedCount: number
        results: Array<{ name: string; success: boolean; error?: string; checksum?: string }>
      }>('/photos/picker/import', {
        method: 'POST',
        body: JSON.stringify({
          sourceAccountId: pickerAccountId,
          targetAccountId: pickerTargetAccountId,
          targetFolderId: pickerTargetFolderId === 'root' ? null : pickerTargetFolderId,
          items: pickedItems,
        }),
      })

      setImportResults(data)
      setPickerStep('completed')
      fetchPhotos()
    } catch (err: any) {
      setPickerErrorMsg(err.message || 'Import failed')
      setPickerStep('error')
    }
  }

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchPhotos()
  }

  // Load target folders whenever targetAccountId changes in transfer modal
  useEffect(() => {
    if (!targetAccountId || !transferModalOpen) return
    setLoadingFolders(true)
    apiFetch<{
      dbFolders: Array<{ id: string; name: string }>
      driveFolders: Array<{ id: string; name: string }>
    }>(`/photos/target-folders/${targetAccountId}`)
      .then((data) => {
        setTargetFolders({
          dbFolders: data.dbFolders || [],
          driveFolders: data.driveFolders || [],
        })
      })
      .catch((err) => console.error('Failed to fetch folders:', err))
      .finally(() => setLoadingFolders(false))
  }, [targetAccountId, transferModalOpen])

  // Group photos by date
  const groupedPhotos = useMemo(() => {
    const groups: { [dateStr: string]: { label: string; photos: PhotoItem[] } } = {}
    for (const photo of photos) {
      const d = new Date(photo.createdAt)
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!groups[dateKey]) {
        const label = new Intl.DateTimeFormat('en', {
          weekday: 'short',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }).format(d)
        groups[dateKey] = { label, photos: [] }
      }
      groups[dateKey].photos.push(photo)
    }
    return Object.entries(groups).map(([key, value]) => ({
      dateKey: key,
      label: value.label,
      photos: value.photos,
    }))
  }, [photos])

  // Selection helpers
  const toggleSelectPhoto = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectDateGroup = (groupPhotos: PhotoItem[]) => {
    const groupIds = groupPhotos.map((p) => p.id)
    const allSelected = groupIds.every((id) => selectedIds.has(id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        groupIds.forEach((id) => next.delete(id))
      } else {
        groupIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const selectAllVisible = () => {
    setSelectedIds(new Set(photos.map((p) => p.id)))
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  // Details & Viewer
  const openViewer = async (photo: PhotoItem) => {
    setViewerPhoto(photo)
    setDetailsLoading(true)
    setPhotoDetails(null)
    try {
      const details = await apiFetch<PhotoDetails>(`/photos/${photo.id}`)
      setPhotoDetails(details)
    } catch (err) {
      console.warn('Failed to load photo details:', err)
    } finally {
      setDetailsLoading(false)
    }
  }

  const nextPhoto = () => {
    if (!viewerPhoto) return
    const idx = photos.findIndex((p) => p.id === viewerPhoto.id)
    if (idx < photos.length - 1) {
      openViewer(photos[idx + 1])
    }
  }

  const prevPhoto = () => {
    if (!viewerPhoto) return
    const idx = photos.findIndex((p) => p.id === viewerPhoto.id)
    if (idx > 0) {
      openViewer(photos[idx - 1])
    }
  }

  // Keyboard navigation for viewer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!viewerPhoto) return
      if (e.key === 'ArrowRight') nextPhoto()
      else if (e.key === 'ArrowLeft') prevPhoto()
      else if (e.key === 'Escape') setViewerPhoto(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewerPhoto, photos])

  // Create new folder in destination
  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !targetAccountId) return
    setCreatingFolder(true)
    try {
      const res = await apiFetch<{ folder: { id: string; name: string } }>('/photos/target-folders', {
        method: 'POST',
        body: JSON.stringify({
          accountId: targetAccountId,
          name: newFolderName.trim(),
          parentFolderId: null,
        }),
      })
      setTargetFolders((prev) => ({
        ...prev,
        dbFolders: [res.folder, ...prev.dbFolders],
      }))
      setTargetFolderId(res.folder.id)
      setNewFolderName('')
    } catch (err: any) {
      alert(`Failed to create folder: ${err.message}`)
    } finally {
      setCreatingFolder(false)
    }
  }

  // Start Transfer
  const handleStartTransfer = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || !targetAccountId) return

    setTransferProgress({
      running: true,
      current: 0,
      total: ids.length,
      results: [],
      completed: false,
    })

    try {
      const data = await apiFetch<{
        transferredCount: number
        failedCount: number
        results: Array<{
          fileId: string
          fileName: string
          success: boolean
          mode: 'copy' | 'move'
          checksum?: string
          error?: string
        }>
      }>('/photos/transfer', {
        method: 'POST',
        body: JSON.stringify({
          fileIds: ids,
          targetAccountId,
          targetFolderId: targetFolderId === 'root' ? null : targetFolderId,
          mode: transferMode,
          verifyChecksum: true,
        }),
      })

      setTransferProgress({
        running: false,
        current: data.transferredCount,
        total: ids.length,
        results: data.results,
        completed: true,
      })

      // Refresh photo list after move
      if (transferMode === 'move') {
        fetchPhotos()
        deselectAll()
      }
    } catch (err: any) {
      alert(`Transfer failed: ${err.message}`)
      setTransferProgress(null)
    }
  }

  // Batch Zip Download
  const handleBatchDownload = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    try {
      const res = await fetch(`${API_URL}/photos/batch-download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fileIds: ids }),
      })
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `9drive-photos-${Date.now()}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(`Download failed: ${err.message}`)
    }
  }

  // Selected size calculation
  const totalSelectedBytes = useMemo(() => {
    return photos
      .filter((p) => selectedIds.has(p.id))
      .reduce((sum, p) => sum + BigInt(p.sizeBytes || 0), 0n)
  }, [photos, selectedIds])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50/60">
      {/* Top Header Bar */}
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 px-6 py-4 backdrop-blur-md">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-indigo-600 text-white shadow-md shadow-indigo-500/20">
                <Images className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-900">Google Photos Manager</h1>
                <p className="text-xs text-slate-500">
                  Lossless bit-for-bit photo & video management with zero compression and MD5 verification
                </p>
              </div>
            </div>
          </div>

          {/* Guarantees Badges */}
          <div className="hidden lg:flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 border border-emerald-200/60">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> Bit-for-Bit Stream
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 border border-blue-200/60">
              <Camera className="h-3.5 w-3.5 text-blue-600" /> EXIF & GPS Preserved
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 border border-indigo-200/60">
              <Sparkles className="h-3.5 w-3.5 text-indigo-600" /> MD5 Verified
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => handleOpenGooglePhotosPicker()}
              className="h-9 gap-1.5 bg-gradient-to-r from-amber-500 via-rose-500 to-indigo-600 text-xs font-bold text-white shadow-md shadow-indigo-500/10 hover:opacity-95"
            >
              <Cloud className="h-4 w-4" />
              Import from photos.google.com
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchPhotos}
              disabled={loading}
              className="h-9 gap-1.5 border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          {/* Account selector & Media filter */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Account dropdown */}
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 shadow-sm">
              <span className="text-xs font-medium text-slate-500">Drive:</span>
              <select
                value={selectedAccountId}
                onChange={(e) => {
                  setSelectedAccountId(e.target.value)
                  setPage(1)
                }}
                className="bg-transparent text-xs font-semibold text-slate-800 focus:outline-none"
              >
                <option value="all">All Connected Accounts ({totalPhotos.toLocaleString()})</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.email}
                  </option>
                ))}
              </select>
            </div>

            {/* Media Type Tabs */}
            <div className="flex rounded-lg border border-slate-200 bg-slate-100/80 p-0.5 text-xs font-medium text-slate-600">
              <button
                type="button"
                onClick={() => {
                  setMediaType('all')
                  setPage(1)
                }}
                className={cn(
                  'rounded-md px-3 py-1 transition-all',
                  mediaType === 'all'
                    ? 'bg-white font-bold text-slate-900 shadow-sm'
                    : 'hover:text-slate-900'
                )}
              >
                All Media
              </button>
              <button
                type="button"
                onClick={() => {
                  setMediaType('image')
                  setPage(1)
                }}
                className={cn(
                  'flex items-center gap-1 rounded-md px-3 py-1 transition-all',
                  mediaType === 'image'
                    ? 'bg-white font-bold text-slate-900 shadow-sm'
                    : 'hover:text-slate-900'
                )}
              >
                <ImageIcon className="h-3 w-3" /> Photos
              </button>
              <button
                type="button"
                onClick={() => {
                  setMediaType('video')
                  setPage(1)
                }}
                className={cn(
                  'flex items-center gap-1 rounded-md px-3 py-1 transition-all',
                  mediaType === 'video'
                    ? 'bg-white font-bold text-slate-900 shadow-sm'
                    : 'hover:text-slate-900'
                )}
              >
                <Video className="h-3 w-3" /> Videos
              </button>
            </div>
          </div>

          {/* Search bar & Selection Actions */}
          <div className="flex items-center gap-2">
            <form onSubmit={handleSearchSubmit} className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search photos..."
                className="h-8 w-44 rounded-lg bg-white pl-8 text-xs sm:w-60"
              />
            </form>

            <Button
              variant="outline"
              size="sm"
              onClick={selectedIds.size === photos.length && photos.length > 0 ? deselectAll : selectAllVisible}
              className="h-8 gap-1 border-slate-200 bg-white text-xs font-semibold text-slate-700"
            >
              {selectedIds.size === photos.length && photos.length > 0 ? (
                <>
                  <CheckSquare className="h-3.5 w-3.5 text-indigo-600" /> Deselect All
                </>
              ) : (
                <>
                  <Square className="h-3.5 w-3.5 text-slate-400" /> Select All Visible
                </>
              )}
            </Button>
          </div>
        </div>
      </header>

      {/* Connection success notification */}
      {connectionSuccess && (
        <div className="mx-6 mt-3 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-800 shadow-sm animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            <span>{connectionSuccess}</span>
          </div>
          <button onClick={() => setConnectionSuccess(null)} className="text-emerald-600 hover:text-emerald-800">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Cloud Photos Banner: Connected & Ready */}
      {accountsWithPhotosAccess.length > 0 && !dismissCloudBanner && (
        <div className="mx-6 mt-3 flex flex-col gap-3 rounded-2xl border border-indigo-200/80 bg-gradient-to-r from-indigo-50/90 via-purple-50/70 to-blue-50/80 p-4 shadow-sm backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between animate-in fade-in">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-rose-500 text-white shadow-sm">
              <Cloud className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold text-slate-900">
                  Google Photos Connected ({accountsWithPhotosAccess.map((a) => a.email).join(', ')})
                </h4>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Ready
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-600 leading-relaxed max-w-2xl">
                Your Google Photos account is connected! Click <strong>Import from photos.google.com</strong> to select and transfer photos directly to your Google Drive gallery with zero local disk storage.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
            <Button
              size="sm"
              onClick={async () => {
                if (!window.confirm('Delete the selected photos from Google Photos? This cannot be undone.')) return;
                try {
                  await apiFetch('/photos', {
                    method: 'DELETE',
                    body: JSON.stringify({
                      accountId: selectedAccountId,
                      mediaItemIds: Array.from(selectedIds),
                    }),
                  });
                  // Refresh UI after deletion
                  setSelectedIds(new Set());
                  fetchPhotos();
                } catch (err) {
                  console.error('Failed to delete photos:', err);
                  alert('Could not delete photos. See console for details.');
                }
              }}
              disabled={selectedIds.size === 0}
              className="h-8 gap-1.5 rounded-xl bg-gray-600 px-3 text-xs font-bold text-white hover:bg-gray-700"
            >
              Delete Selected
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await apiFetch('/photos', {
                    method: 'DELETE',
                    body: JSON.stringify({
                      accountId: pickerTargetAccountId,
                      mediaItemIds: pickedItems.map((i) => i.id),
                    }),
                  });
                  // Refresh UI after deletion
                  setPickedItems([]);
                  setPickerStep('opening');
                } catch (err) {
                  console.error('Failed to delete photos:', err);
                  alert('Could not delete photos. See console for details.');
                }
              }}
              disabled={pickedItems.length === 0}
              className="h-8 gap-1.5 rounded-xl bg-gray-600 px-3 text-xs font-bold text-white hover:bg-gray-700"
            >
              Delete from Google Photos
            </Button>
            <button
              onClick={() => setDismissCloudBanner(true)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/50 hover:text-slate-600"
              title="Dismiss banner"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Cloud Photos Notice: Action Required only if NO account has photos access */}
      {accountsWithPhotosAccess.length === 0 && accountsNeedingPhotosAccess.length > 0 && !dismissCloudBanner && (
        <div className="mx-6 mt-3 flex flex-col gap-3 rounded-2xl border border-amber-200/80 bg-gradient-to-r from-amber-50/90 via-orange-50/70 to-indigo-50/80 p-4 shadow-sm backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between animate-in fade-in">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-rose-500 text-white shadow-sm">
              <Cloud className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold text-slate-900">
                  Connect photos.google.com Cloud Library (~14 GB)
                </h4>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                  Action Required
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-600 leading-relaxed max-w-2xl">
                Google keeps photos on <code className="font-semibold text-slate-800">photos.google.com</code> separated from Google Drive. To browse and transfer your Google Photos library directly into your Google Drive folders without downloading anything to your local disk, grant Google Photos Picker access.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
            <Button
              size="sm"
              onClick={handleConnectPhotos}
              disabled={connectingGoogle}
              className="h-8 gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 px-3 text-xs font-bold text-white shadow hover:opacity-90"
            >
              {connectingGoogle ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Grant Google Photos Access
                </>
              )}
            </Button>
            <button
              onClick={() => setDismissCloudBanner(true)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/50 hover:text-slate-600"
              title="Dismiss banner"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Floating Selection Action Bar */}
      {selectedIds.size > 0 && (
        <div className="sticky top-28 z-30 mx-auto -mb-14 mt-3 flex w-[90%] max-w-2xl items-center justify-between rounded-2xl border border-indigo-200 bg-indigo-950/90 px-4 py-2.5 text-white shadow-xl shadow-indigo-950/20 backdrop-blur-lg animate-in fade-in slide-in-from-top-4">
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-500 text-xs font-bold text-white shadow-inner">
              {selectedIds.size}
            </span>
            <div>
              <p className="text-xs font-bold text-white leading-tight">
                {selectedIds.size} {selectedIds.size === 1 ? 'photo' : 'photos'} selected
              </p>
              <p className="text-[11px] text-indigo-200">{formatBytes(totalSelectedBytes)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setTransferModalOpen(true)}
              className="h-8 gap-1.5 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 px-3 text-xs font-bold text-white shadow hover:from-blue-600 hover:to-indigo-600"
            >
              <ArrowRight className="h-3.5 w-3.5" /> Transfer / Move to Drive
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBatchDownload}
              className="h-8 gap-1.5 rounded-xl border-indigo-700 bg-indigo-900/60 px-3 text-xs font-medium text-indigo-100 hover:bg-indigo-800"
            >
              <Download className="h-3.5 w-3.5" /> Download Zip
            </Button>
            <button
              onClick={deselectAll}
              className="rounded-lg p-1.5 text-indigo-300 hover:bg-indigo-800/80 hover:text-white"
              title="Deselect"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto px-6 py-6">
        {loading && photos.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-slate-400">
            <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
            <p className="text-sm font-semibold">Loading your Google Photos...</p>
          </div>
        ) : photos.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-white p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Images className="h-7 w-7" />
            </div>
            <h3 className="mt-4 text-base font-bold text-slate-900">No photos or videos found</h3>
            <p className="mt-1 max-w-sm text-xs text-slate-500">
              {searchQuery
                ? 'No media matches your search query. Try clearing the search.'
                : 'Your connected Google Drive accounts do not currently have photos in Drive, or your photos reside in photos.google.com.'}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
              <Button
                onClick={() => handleOpenGooglePhotosPicker()}
                className="h-9 gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 via-rose-500 to-indigo-600 text-xs font-bold text-white shadow-md hover:opacity-95"
              >
                <Cloud className="h-4 w-4" />
                Import from photos.google.com (14 GB)
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {groupedPhotos.map(({ dateKey, label, photos: groupPhotos }) => {
              const allGroupSelected = groupPhotos.every((p) => selectedIds.has(p.id))
              const someGroupSelected = groupPhotos.some((p) => selectedIds.has(p.id))

              return (
                <section key={dateKey} className="space-y-3">
                  {/* Date Section Header */}
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => toggleSelectDateGroup(groupPhotos)}
                      className="group flex items-center gap-2 text-left"
                    >
                      <div
                        className={cn(
                          'flex h-4 w-4 items-center justify-center rounded border transition-colors',
                          allGroupSelected
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : someGroupSelected
                            ? 'border-indigo-400 bg-indigo-100 text-indigo-700'
                            : 'border-slate-300 bg-white group-hover:border-slate-400'
                        )}
                      >
                        {allGroupSelected && <Check className="h-3 w-3 stroke-[3]" />}
                        {!allGroupSelected && someGroupSelected && (
                          <div className="h-1.5 w-1.5 rounded-sm bg-indigo-600" />
                        )}
                      </div>
                      <h2 className="text-sm font-bold text-slate-800 group-hover:text-indigo-600 transition-colors">
                        {label}
                      </h2>
                    </button>
                    <span className="text-xs text-slate-400">
                      • {groupPhotos.length} {groupPhotos.length === 1 ? 'item' : 'items'}
                    </span>
                  </div>

                  {/* Photo Cards Grid */}
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
                    {groupPhotos.map((photo) => {
                      const isSelected = selectedIds.has(photo.id)
                      const isVideo = photo.mimeType.startsWith('video/')
                      const thumbnailSrc = `${API_URL}${photo.thumbnailUrl}?token=${token}&size=400`

                      return (
                        <div
                          key={photo.id}
                          onClick={() => openViewer(photo)}
                          className={cn(
                            'group relative aspect-square cursor-pointer overflow-hidden rounded-xl border bg-slate-100 transition-all duration-150',
                            isSelected
                              ? 'border-indigo-600 ring-2 ring-indigo-600 ring-offset-2'
                              : 'border-slate-200 hover:border-slate-300 hover:shadow-md'
                          )}
                        >
                          {/* Thumbnail */}
                          <img
                            src={thumbnailSrc}
                            alt={photo.name}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                            onError={(e) => {
                              // Fallback to stream if thumbnail redirect fails
                              const img = e.currentTarget
                              if (!img.src.includes('/stream')) {
                                img.src = `${API_URL}${photo.streamUrl}?token=${token}`
                              }
                            }}
                          />

                          {/* Gradient overlay on hover */}
                          <div
                            className={cn(
                              'absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/30 transition-opacity',
                              isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            )}
                          />

                          {/* Checkbox toggle in top-left */}
                          <button
                            type="button"
                            onClick={(e) => toggleSelectPhoto(photo.id, e)}
                            className={cn(
                              'absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-lg shadow-sm transition-all',
                              isSelected
                                ? 'bg-indigo-600 text-white shadow-indigo-600/30'
                                : 'bg-black/40 text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 hover:bg-black/60'
                            )}
                          >
                            {isSelected ? (
                              <Check className="h-3.5 w-3.5 stroke-[3]" />
                            ) : (
                              <div className="h-3 w-3 rounded-sm border border-white/80" />
                            )}
                          </button>

                          {/* Video Badge in top-right */}
                          {isVideo && (
                            <div className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                              <Play className="h-2.5 w-2.5 fill-white" />
                              <span>VIDEO</span>
                            </div>
                          )}

                          {/* Account Tag in bottom-right */}
                          <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity">
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: photo.connectedAccount.color || '#3b82f6' }}
                            />
                            <span className="max-w-[70px] truncate text-[9px]">
                              {photo.connectedAccount.displayName || photo.connectedAccount.email.split('@')[0]}
                            </span>
                          </div>

                          {/* File Size & Name on hover in bottom-left */}
                          <div className="absolute bottom-2 left-2 right-12 truncate text-[11px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity">
                            <p className="truncate drop-shadow">{photo.name}</p>
                            <p className="text-[9px] text-white/70">{formatBytes(photo.sizeBytes)}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-6">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="h-8 gap-1 text-xs"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </Button>
                <span className="text-xs font-semibold text-slate-600">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="h-8 gap-1 text-xs"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ========================================================================= */}
      {/* FULLSCREEN PHOTO / VIDEO VIEWER MODAL WITH METADATA SIDEBAR               */}
      {/* ========================================================================= */}
      {viewerPhoto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 text-white backdrop-blur-xl animate-in fade-in">
          {/* Top Bar */}
          <div className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between border-b border-white/10 bg-black/40 px-6 py-3 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setViewerPhoto(null)}
                className="rounded-lg p-1.5 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                title="Close (Esc)"
              >
                <X className="h-5 w-5" />
              </button>
              <div>
                <p className="text-sm font-bold text-white max-w-md truncate">{viewerPhoto.name}</p>
                <p className="text-[11px] text-white/60">
                  {formatDate(viewerPhoto.createdAt)} • {formatBytes(viewerPhoto.sizeBytes)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSelectedIds(new Set([viewerPhoto.id]))
                  setTransferModalOpen(true)
                }}
                className="h-8 gap-1.5 border-white/20 bg-white/10 text-xs font-semibold text-white hover:bg-white/20"
              >
                <ArrowRight className="h-3.5 w-3.5" /> Transfer / Move
              </Button>
              <a
                href={`${API_URL}${viewerPhoto.streamUrl}?token=${token}`}
                download={viewerPhoto.name}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/20 bg-white/10 px-3 text-xs font-semibold text-white hover:bg-white/20 transition-colors"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
              <button
                onClick={() => setShowInfoSidebar(!showInfoSidebar)}
                className={cn(
                  'rounded-lg p-2 transition-colors',
                  showInfoSidebar ? 'bg-indigo-600 text-white' : 'bg-white/10 text-white/80 hover:bg-white/20'
                )}
                title="Photo Details & EXIF"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Previous / Next Arrow Controls */}
          <button
            onClick={prevPhoto}
            className="absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/50 p-2.5 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transition-all"
            title="Previous (Left Arrow)"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            onClick={nextPhoto}
            className="absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/50 p-2.5 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transition-all"
            title="Next (Right Arrow)"
          >
            <ChevronRight className="h-6 w-6" />
          </button>

          {/* Media Container */}
          <div className="flex h-full w-full items-center justify-center p-12">
            {viewerPhoto.mimeType.startsWith('video/') ? (
              <video
                controls
                autoPlay
                playsInline
                className="max-h-[85vh] max-w-[85vw] rounded-lg shadow-2xl"
                src={`${API_URL}${viewerPhoto.streamUrl}?token=${token}`}
              >
                <source src={`${API_URL}${viewerPhoto.streamUrl}?token=${token}`} type={viewerPhoto.mimeType} />
              </video>
            ) : (
              <img
                src={`${API_URL}${viewerPhoto.streamUrl}?token=${token}`}
                alt={viewerPhoto.name}
                className="max-h-[85vh] max-w-[85vw] object-contain shadow-2xl select-none"
              />
            )}
          </div>

          {/* EXIF / Metadata Sidebar */}
          {showInfoSidebar && (
            <aside className="absolute right-0 top-14 bottom-0 z-30 w-80 overflow-y-auto border-l border-white/10 bg-slate-950/95 p-5 backdrop-blur-2xl animate-in slide-in-from-right">
              <div className="flex items-center justify-between pb-3 border-b border-white/10">
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Info className="h-4 w-4 text-indigo-400" /> Photo Information
                </h3>
                <button
                  onClick={() => setShowInfoSidebar(false)}
                  className="rounded p-1 text-white/60 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {detailsLoading ? (
                <div className="py-8 text-center text-xs text-white/50">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-indigo-400" />
                  Loading EXIF metadata...
                </div>
              ) : (
                <div className="mt-4 space-y-4 text-xs">
                  {/* Bit-for-bit Guarantee Banner */}
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-3 text-emerald-300">
                    <div className="flex items-center gap-1.5 font-bold">
                      <ShieldCheck className="h-4 w-4 text-emerald-400" /> Zero Quality Loss Guaranteed
                    </div>
                    <p className="mt-1 text-[11px] text-emerald-400/80">
                      Raw binary stream identical to the original file. All EXIF, GPS coordinates, and camera markers are 100% preserved.
                    </p>
                  </div>

                  {/* File Basics */}
                  <div>
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">File Details</h4>
                    <div className="mt-2 space-y-2 rounded-xl bg-white/5 p-3 text-slate-300">
                      <div>
                        <span className="text-slate-500">Filename:</span>
                        <p className="font-semibold text-white break-all">{photoDetails?.file.name || viewerPhoto.name}</p>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">File Size:</span>
                        <span className="font-semibold text-white">{formatBytes(photoDetails?.file.sizeBytes || viewerPhoto.sizeBytes)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Format:</span>
                        <span className="font-semibold text-white">{viewerPhoto.mimeType}</span>
                      </div>
                      {photoDetails?.dimensions && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Resolution:</span>
                          <span className="font-semibold text-white">
                            {photoDetails.dimensions.width} × {photoDetails.dimensions.height} px
                          </span>
                        </div>
                      )}
                      {photoDetails?.file.checksum && (
                        <div>
                          <span className="text-slate-500">MD5 Checksum:</span>
                          <p className="font-mono text-[10px] text-indigo-300 break-all">{photoDetails.file.checksum}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Camera & EXIF */}
                  {(photoDetails?.camera?.make || photoDetails?.camera?.model) && (
                    <div>
                      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <Camera className="h-3.5 w-3.5 text-blue-400" /> Camera & EXIF
                      </h4>
                      <div className="mt-2 space-y-1.5 rounded-xl bg-white/5 p-3 text-slate-300">
                        {photoDetails.camera.make && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Make:</span>
                            <span className="font-semibold text-white">{photoDetails.camera.make}</span>
                          </div>
                        )}
                        {photoDetails.camera.model && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Model:</span>
                            <span className="font-semibold text-white">{photoDetails.camera.model}</span>
                          </div>
                        )}
                        {photoDetails.camera.focalLength && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Focal Length:</span>
                            <span className="font-semibold text-white">{photoDetails.camera.focalLength} mm</span>
                          </div>
                        )}
                        {photoDetails.camera.aperture && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Aperture:</span>
                            <span className="font-semibold text-white">f/{photoDetails.camera.aperture}</span>
                          </div>
                        )}
                        {photoDetails.camera.iso && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">ISO:</span>
                            <span className="font-semibold text-white">{photoDetails.camera.iso}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Storage Location */}
                  <div>
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <HardDrive className="h-3.5 w-3.5 text-indigo-400" /> Storage Account
                    </h4>
                    <div className="mt-2 space-y-1 rounded-xl bg-white/5 p-3 text-slate-300">
                      <p className="font-semibold text-white">{viewerPhoto.connectedAccount.email}</p>
                      <p className="text-[11px] text-slate-500">
                        Provider: {viewerPhoto.connectedAccount.provider}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TRANSFER PHOTOS MODAL (COPY OR MOVE WITH DESTINATION FOLDER PICKER)        */}
      {/* ========================================================================= */}
      {transferModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <ArrowRight className="h-4 w-4" />
                </div>
                <h3 className="text-base font-bold text-slate-900">Transfer Photos to Drive</h3>
              </div>
              <button
                onClick={() => {
                  setTransferModalOpen(false)
                  setTransferProgress(null)
                }}
                className="rounded p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {transferProgress?.completed ? (
              /* Completion View */
              <div className="py-6 text-center space-y-4">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                  <Check className="h-8 w-8 stroke-[3]" />
                </div>
                <div>
                  <h4 className="text-lg font-bold text-slate-900">Transfer Completed Successfully!</h4>
                  <p className="mt-1 text-xs text-slate-500">
                    {transferProgress.results.filter((r) => r.success).length} of {transferProgress.total} photos transferred with 100% verified MD5 checksums.
                  </p>
                </div>

                <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50 p-3 text-left space-y-2 text-xs">
                  {transferProgress.results.map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px]">
                      <span className="font-medium text-slate-700 truncate max-w-[280px]">{r.fileName}</span>
                      {r.success ? (
                        <span className="text-emerald-600 font-semibold flex items-center gap-1">
                          <Check className="h-3 w-3" /> Verified MD5
                        </span>
                      ) : (
                        <span className="text-rose-600 font-semibold">{r.error || 'Failed'}</span>
                      )}
                    </div>
                  ))}
                </div>

                <Button
                  className="w-full bg-slate-900 text-white hover:bg-slate-800"
                  onClick={() => {
                    setTransferModalOpen(false)
                    setTransferProgress(null)
                  }}
                >
                  Done
                </Button>
              </div>
            ) : transferProgress?.running ? (
              /* Live Progress View */
              <div className="py-8 text-center space-y-4">
                <Loader2 className="mx-auto h-10 w-10 animate-spin text-indigo-600" />
                <div>
                  <h4 className="text-base font-bold text-slate-900">Streaming Photos Losslessly...</h4>
                  <p className="mt-1 text-xs text-slate-500">
                    Direct stream-to-stream pipeline. Performing MD5 checksum integrity checks.
                  </p>
                </div>
                <div className="w-full rounded-full bg-slate-100 h-2.5 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-300 animate-pulse w-full" />
                </div>
              </div>
            ) : (
              /* Configuration View */
              <div className="mt-4 space-y-5">
                {/* Selection Summary */}
                <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100 text-xs text-slate-600 space-y-1">
                  <p className="font-bold text-slate-800">
                    Selected: {selectedIds.size} {selectedIds.size === 1 ? 'photo' : 'photos'} ({formatBytes(totalSelectedBytes)})
                  </p>
                  <p className="text-slate-500 text-[11px]">
                    Files will be streamed bit-for-bit with complete preservation of EXIF data, GPS coordinates, and camera timestamps.
                  </p>
                </div>

                {/* Mode Selector: Copy vs Move */}
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-2">Transfer Mode</label>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setTransferMode('copy')}
                      className={cn(
                        'flex flex-col text-left p-3 rounded-xl border transition-all',
                        transferMode === 'copy'
                          ? 'border-indigo-600 bg-indigo-50/50 ring-1 ring-indigo-600'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-bold text-xs text-slate-900">
                        <Copy className="h-3.5 w-3.5 text-indigo-600" /> Copy to Target
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Keep originals on source drive. Create identical bit-for-bit copies on destination.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setTransferMode('move')}
                      className={cn(
                        'flex flex-col text-left p-3 rounded-xl border transition-all',
                        transferMode === 'move'
                          ? 'border-amber-600 bg-amber-50/50 ring-1 ring-amber-600'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-bold text-xs text-amber-900">
                        <Move className="h-3.5 w-3.5 text-amber-600" /> Move to Target
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Free up storage on source drive. Safely trashes source file <b>only after</b> MD5 verification matches.
                      </p>
                    </button>
                  </div>
                </div>

                {/* Target Google Account */}
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1.5">Destination Google Drive Account</label>
                  <select
                    value={targetAccountId}
                    onChange={(e) => setTargetAccountId(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:outline-none"
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.email} ({acc.displayName || 'Google Drive'})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Destination Folder Selector */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-700">Destination Folder</label>
                    <span className="text-[11px] text-slate-400">Where to store photos</span>
                  </div>

                  <select
                    value={targetFolderId}
                    onChange={(e) => setTargetFolderId(e.target.value)}
                    disabled={loadingFolders}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="root">My Drive (Root Folder)</option>
                    <option value="9drive">9drive (Dedicated App Folder)</option>
                    {targetFolders.dbFolders.length > 0 && (
                      <optgroup label="9Drive Virtual Folders">
                        {targetFolders.dbFolders.map((f) => (
                          <option key={f.id} value={f.id}>
                            📁 {f.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {targetFolders.driveFolders.length > 0 && (
                      <optgroup label="Google Drive Native Folders">
                        {targetFolders.driveFolders.map((f) => (
                          <option key={f.id} value={f.id}>
                            📂 {f.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {/* Create New Folder Inline */}
                  <div className="mt-2 flex gap-1.5">
                    <Input
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="Or create new folder (e.g. Vacation 2026)..."
                      className="h-8 rounded-lg text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCreateFolder}
                      disabled={creatingFolder || !newFolderName.trim()}
                      className="h-8 gap-1 text-xs shrink-0 font-semibold"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      {creatingFolder ? 'Creating...' : 'Create'}
                    </Button>
                  </div>
                </div>

                {/* Zero Loss Guarantee Checklist */}
                <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-[11px] text-slate-600 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                    <Check className="h-3.5 w-3.5" /> 100% Bit-for-bit binary stream (zero transcoding)
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                    <Check className="h-3.5 w-3.5" /> Full EXIF, GPS coordinates, and timestamps preserved
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                    <Check className="h-3.5 w-3.5" /> Source files protected: never trashed unless MD5 matches
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                  <Button
                    variant="outline"
                    onClick={() => setTransferModalOpen(false)}
                    className="h-9 text-xs"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleStartTransfer}
                    className="h-9 gap-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-xs font-bold text-white shadow-md hover:from-blue-700 hover:to-indigo-700"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                    {transferMode === 'copy' ? 'Start Lossless Copy' : 'Start Lossless Move'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* Google Photos Cloud Picker Modal (photos.google.com -> Drive) */}
      {/* ============================================================ */}
      {pickerModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm animate-in fade-in">
          <div className="relative w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl animate-in zoom-in-95">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 via-rose-500 to-indigo-600 text-white shadow-md">
                  <Cloud className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Import from photos.google.com
                  </h3>
                  <p className="text-xs text-slate-500">
                    Pure cloud-to-cloud stream: zero local disk storage used
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPickerModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body depending on pickerStep */}
            <div className="mt-5 space-y-4">
              {/* STEP: permission_needed */}
              {pickerStep === 'permission_needed' && (
                <div className="space-y-4 py-2 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-600">
                    <AlertCircle className="h-7 w-7" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">
                      Google Photos Permission Required
                    </h4>
                    <p className="mx-auto mt-1.5 max-w-md text-xs text-slate-600 leading-relaxed">
                      Google keeps <strong>photos.google.com</strong> separated from Google Drive. Your account{' '}
                      <span className="font-semibold text-slate-800">
                        ({accounts.find((a) => a.id === pickerAccountId)?.email || 'Google Account'})
                      </span>{' '}
                      needs one-time permission to allow 9Drive to stream your photos into Google Drive.
                    </p>
                  </div>

                  <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 p-3 text-left text-xs text-amber-900">
                    <p className="font-semibold flex items-center gap-1.5">
                      <ShieldCheck className="h-4 w-4 text-amber-600" />
                      Zero Local Storage Guarantee
                    </p>
                    <p className="mt-1 text-[11px] text-amber-800">
                      Files are piped directly across Google Cloud servers in memory. Nothing is downloaded or saved to your computer or server disk.
                    </p>
                  </div>

                  <div className="flex items-center justify-center gap-2 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => setPickerModalOpen(false)}
                      className="h-9 text-xs"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleConnectPhotos}
                      disabled={connectingGoogle}
                      className="h-9 gap-1.5 bg-gradient-to-r from-amber-500 to-rose-500 text-xs font-bold text-white shadow hover:opacity-90"
                    >
                      {connectingGoogle ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Authorizing...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-3.5 w-3.5" />
                          Grant Google Photos Permission
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {/* STEP: api_disabled (Google Cloud Console activation required) */}
              {pickerStep === 'api_disabled' && (
                <div className="space-y-4 py-2 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600">
                    <Cloud className="h-7 w-7" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">
                      Enable Google Photos Picker API
                    </h4>
                    <p className="mx-auto mt-1.5 max-w-md text-xs text-slate-600 leading-relaxed">
                      Your Google Cloud Project (<strong>866882368661</strong>) requires the <strong>Google Photos Picker API</strong> to be enabled once. This takes 5 seconds.
                    </p>
                  </div>

                  <div className="rounded-xl border border-blue-200/80 bg-blue-50/70 p-3 text-left text-xs text-blue-950 space-y-1">
                    <p className="font-semibold flex items-center gap-1.5 text-blue-900">
                      <ExternalLink className="h-4 w-4 text-blue-600" />
                      Quick 1-Click Instructions:
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-[11px] text-blue-800">
                      <li>Click the button below to open Google Cloud Console</li>
                      <li>Click the blue <strong>ENABLE</strong> button</li>
                      <li>Return here and click <strong>I Have Enabled It - Try Again</strong></li>
                    </ol>
                  </div>

                  <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
                    <a
                      href={pickerActivationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow hover:from-blue-700 hover:to-indigo-700 w-full sm:w-auto"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open Google Cloud Console
                    </a>
                    <Button
                      onClick={() => startPickerSession(pickerAccountId)}
                      className="h-10 gap-1.5 bg-emerald-600 text-xs font-bold text-white shadow hover:bg-emerald-700 w-full sm:w-auto"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      I Have Enabled It - Try Again
                    </Button>
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setPickerModalOpen(false)}
                      className="text-xs text-slate-400 hover:text-slate-600"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* STEP: opening / polling */}
              {(pickerStep === 'opening' || pickerStep === 'polling') && (
                <div className="space-y-4 py-4 text-center">
                  <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
                    <div className="absolute inset-0 animate-ping rounded-full bg-indigo-400/20" />
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-rose-500 text-white shadow-lg">
                      <Cloud className="h-8 w-8 animate-pulse" />
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-bold text-slate-900">
                      Google Photos Selection Window Open
                    </h4>
                    <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                      Please select the photos or albums you want to import in the Google Photos popup, then click <strong>Done</strong>.
                    </p>
                  </div>

                  <div className="flex items-center justify-center gap-2 text-xs text-indigo-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Waiting for your selection in Google Photos...</span>
                  </div>

                  {pickerUri && (
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => window.open(pickerUri!, 'google_photos_picker', 'width=1024,height=768')}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800 underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Did the popup not open? Click here to open Google Photos
                      </button>
                    </div>
                  )}

                  <div className="border-t border-slate-100 pt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPickerModalOpen(false)}
                      className="h-8 text-xs text-slate-600"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* STEP: ready_to_import */}
              {pickerStep === 'ready_to_import' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-xl bg-indigo-50/70 p-3 text-xs text-indigo-950">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-indigo-600" />
                      <span className="font-bold">
                        {pickedItems.length} {pickedItems.length === 1 ? 'photo' : 'photos / videos'} selected from Google Photos
                      </span>
                    </div>
                    <span className="text-[11px] text-indigo-700">Ready to transfer</span>
                  </div>

                  {/* Picked items thumbnail carousel/preview */}
                  <div className="flex gap-2 overflow-x-auto rounded-xl border border-slate-100 bg-slate-50/50 p-2.5 max-h-36">
                    {pickedItems.slice(0, 10).map((item) => (
                      <div
                        key={item.id}
                        className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-200 shadow-sm"
                      >
                        <img
                          src={`${item.baseUrl}=w200-h200-c`}
                          alt={item.name}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                        <span className="absolute bottom-0 inset-x-0 bg-black/60 px-1 py-0.5 text-[9px] text-white truncate">
                          {item.name}
                        </span>
                      </div>
                    ))}
                    {pickedItems.length > 10 && (
                      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-xs font-bold text-slate-500">
                        +{pickedItems.length - 10} more
                      </div>
                    )}
                  </div>

                  {/* Destination Account */}
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1">
                      Destination Google Drive Account
                    </label>
                    <select
                      value={pickerTargetAccountId}
                      onChange={(e) => setPickerTargetAccountId(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:outline-none"
                    >
                      {accounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.email} ({acc.displayName || 'Google Drive'})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Destination Folder */}
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1">
                      Destination Folder in Google Drive
                    </label>
                    <select
                      value={pickerTargetFolderId}
                      onChange={(e) => setPickerTargetFolderId(e.target.value)}
                      disabled={pickerFoldersLoading}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:outline-none"
                    >
                      <option value="root">My Drive (Root Folder)</option>
                      <option value="9drive">9drive (Dedicated App Folder)</option>
                      {pickerFolders.dbFolders.length > 0 && (
                        <optgroup label="9Drive Virtual Folders">
                          {pickerFolders.dbFolders.map((f) => (
                            <option key={f.id} value={f.id}>
                              📁 {f.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {pickerFolders.driveFolders.length > 0 && (
                        <optgroup label="Google Drive Native Folders">
                          {pickerFolders.driveFolders.map((f) => (
                            <option key={f.id} value={f.id}>
                              📂 {f.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>

                    {/* Inline Create Folder */}
                    <div className="mt-2 flex gap-1.5">
                      <Input
                        value={pickerNewFolderName}
                        onChange={(e) => setPickerNewFolderName(e.target.value)}
                        placeholder="Or create folder (e.g. Google Photos Backup)..."
                        className="h-8 rounded-lg text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleCreatePickerFolder}
                        disabled={pickerCreatingFolder || !pickerNewFolderName.trim()}
                        className="h-8 gap-1 text-xs shrink-0 font-semibold"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                        {pickerCreatingFolder ? 'Creating...' : 'Create'}
                      </Button>
                    </div>
                  </div>

                  {/* Guarantees Box */}
                  <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 text-[11px] text-emerald-800 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                      Zero Local Storage Used: Streamed in-memory directly to Google Drive
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                      Exact bit-for-bit resolution with full EXIF metadata and MD5 checksum
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                    <Button
                      variant="outline"
                      onClick={() => setPickerModalOpen(false)}
                      className="h-9 text-xs"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleStartPickerImport}
                      className="h-9 gap-1.5 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-xs font-bold text-white shadow-md hover:opacity-95"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                      Start Cloud Transfer (Direct to Drive)
                    </Button>
                  </div>
                </div>
              )}

              {/* STEP: importing */}
              {pickerStep === 'importing' && (
                <div className="space-y-4 py-8 text-center">
                  <Loader2 className="mx-auto h-10 w-10 animate-spin text-indigo-600" />
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">
                      Streaming Photos to Google Drive...
                    </h4>
                    <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                      Transferring {pickedItems.length} items in-memory directly into your Google Drive folder. No files are written to local disk.
                    </p>
                  </div>
                  <div className="mx-auto max-w-xs rounded-full bg-indigo-100 h-2 overflow-hidden">
                    <div className="h-full bg-indigo-600 animate-pulse rounded-full w-3/4" />
                  </div>
                </div>
              )}

              {/* STEP: completed */}
              {pickerStep === 'completed' && importResults && (
                <div className="space-y-4 py-2">
                  <div className="flex items-center gap-3 rounded-xl bg-emerald-50 p-4 text-emerald-900">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600 shrink-0" />
                    <div>
                      <h4 className="text-sm font-bold">Cloud Transfer Completed!</h4>
                      <p className="text-xs text-emerald-700 mt-0.5">
                        Successfully transferred {importResults.importedCount} of {importResults.results.length} photos directly to your Google Drive.
                      </p>
                    </div>
                  </div>

                  {/* Transfer Result Items */}
                  <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/50 p-2">
                    {importResults.results.map((res, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 px-2 text-xs">
                        <div className="flex items-center gap-2 truncate pr-2">
                          {res.success ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                          ) : (
                            <X className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                          )}
                          <span className="truncate font-medium text-slate-800">{res.name}</span>
                        </div>
                        {res.checksum && (
                          <span className="shrink-0 font-mono text-[10px] text-slate-400">
                            MD5: {res.checksum.slice(0, 8)}...
                          </span>
                        )}
                        {res.error && (
                          <span className="shrink-0 text-[10px] text-rose-600">{res.error}</span>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end pt-2 border-t border-slate-100">
                    <Button
                      onClick={() => {
                        setPickerModalOpen(false)
                        fetchPhotos()
                      }}
                      className="h-9 bg-indigo-600 text-xs font-bold text-white shadow hover:bg-indigo-700"
                    >
                      Done & View Photos
                    </Button>
                  </div>
                </div>
              )}

              {/* STEP: error */}
              {pickerStep === 'error' && (
                <div className="space-y-4 py-4 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-600">
                    <AlertCircle className="h-6 w-6" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">Transfer Encountered an Issue</h4>
                    <p className="mx-auto mt-1 max-w-md text-xs text-rose-600">
                      {pickerErrorMsg || 'Failed to process Google Photos selection.'}
                    </p>
                  </div>
                  <div className="flex justify-center gap-2 pt-2 border-t border-slate-100">
                    <Button
                      variant="outline"
                      onClick={() => setPickerModalOpen(false)}
                      className="h-8 text-xs"
                    >
                      Close
                    </Button>
                    <Button
                      onClick={() => handleOpenGooglePhotosPicker(pickerAccountId)}
                      className="h-8 text-xs font-semibold bg-indigo-600 text-white"
                    >
                      Try Again
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
