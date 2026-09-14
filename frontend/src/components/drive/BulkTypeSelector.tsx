import { useMemo } from 'react'
import {
  FileText,
  Image as ImageIcon,
  Video,
  Music,
  Archive,
  CheckSquare,
  Square,
  Layers,
} from 'lucide-react'
import type { FileItem } from '@/data/drive-data'

type BulkTypeSelectorProps = {
  files: FileItem[]
  selectedFileIds: Set<string>
  onSelectType: (kind: string, action: 'select' | 'toggle' | 'deselect') => void
  onSelectAll: () => void
  onClear: () => void
}

export type FileKindMeta = {
  key: string
  label: string
  icon: typeof FileText
  color: string
  bg: string
  border: string
  filter: (f: FileItem) => boolean
}

export const FILE_KIND_DEFINITIONS: FileKindMeta[] = [
  {
    key: 'image',
    label: 'Images',
    icon: ImageIcon,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    border: 'border-emerald-200 dark:border-emerald-800',
    filter: (f) => f.kind === 'image' || (f.mimeType?.startsWith('image/') ?? false),
  },
  {
    key: 'video',
    label: 'Videos',
    icon: Video,
    color: 'text-indigo-600',
    bg: 'bg-indigo-50 dark:bg-indigo-950/40',
    border: 'border-indigo-200 dark:border-indigo-800',
    filter: (f) => f.kind === 'video' || (f.mimeType?.startsWith('video/') ?? false),
  },
  {
    key: 'pdf',
    label: 'PDFs',
    icon: FileText,
    color: 'text-red-600',
    bg: 'bg-red-50 dark:bg-red-950/40',
    border: 'border-red-200 dark:border-red-800',
    filter: (f) => f.kind === 'pdf' || (f.mimeType?.includes('pdf') ?? false),
  },
  {
    key: 'doc',
    label: 'Documents',
    icon: FileText,
    color: 'text-blue-600',
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    border: 'border-blue-200 dark:border-blue-800',
    filter: (f) =>
      f.kind === 'doc' &&
      !(f.mimeType?.includes('pdf') || f.mimeType?.startsWith('audio/') || f.mimeType?.includes('zip')),
  },
  {
    key: 'audio',
    label: 'Audio',
    icon: Music,
    color: 'text-purple-600',
    bg: 'bg-purple-50 dark:bg-purple-950/40',
    border: 'border-purple-200 dark:border-purple-800',
    filter: (f) => f.kind === 'audio' || (f.mimeType?.startsWith('audio/') ?? false),
  },
  {
    key: 'archive',
    label: 'Archives',
    icon: Archive,
    color: 'text-amber-600',
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    border: 'border-amber-200 dark:border-amber-800',
    filter: (f) =>
      f.kind === 'archive' ||
      (f.mimeType?.includes('zip') ||
        f.mimeType?.includes('tar') ||
        f.mimeType?.includes('rar') ||
        f.mimeType?.includes('7z') ||
        false),
  },
]

export function BulkTypeSelector({
  files,
  selectedFileIds,
  onSelectType,
  onSelectAll,
  onClear,
}: BulkTypeSelectorProps) {
  // Compute counts and selected counts per data type
  const typeStats = useMemo(() => {
    return FILE_KIND_DEFINITIONS.map((def) => {
      const matchingFiles = files.filter(def.filter)
      const selectedCount = matchingFiles.filter((f) => f.id && selectedFileIds.has(f.id)).length
      const totalCount = matchingFiles.length
      const isAllSelected = totalCount > 0 && selectedCount === totalCount
      const isPartiallySelected = selectedCount > 0 && selectedCount < totalCount

      return {
        ...def,
        totalCount,
        selectedCount,
        isAllSelected,
        isPartiallySelected,
      }
    }).filter((stat) => stat.totalCount > 0)
  }, [files, selectedFileIds])

  if (files.length === 0) return null

  const allSelected = files.length > 0 && files.every((f) => f.id && selectedFileIds.has(f.id))

  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mr-1 hidden sm:inline-flex items-center gap-1">
        <Layers className="h-3 w-3" /> Select Bulk:
      </span>

      {/* Select All pill */}
      <button
        type="button"
        onClick={allSelected ? onClear : onSelectAll}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold border transition-all ${
          allSelected
            ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
        }`}
      >
        {allSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        <span>All ({files.length})</span>
      </button>

      {/* Category Pills */}
      {typeStats.map((stat) => {
        const Icon = stat.icon
        const active = stat.isAllSelected
        const partial = stat.isPartiallySelected

        return (
          <button
            key={stat.key}
            type="button"
            onClick={() => onSelectType(stat.key, active ? 'deselect' : 'select')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold border transition-all ${
              active
                ? `${stat.bg} ${stat.border} ${stat.color} ring-1 ring-current shadow-xs`
                : partial
                ? `${stat.bg} ${stat.border} ${stat.color} opacity-85`
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400'
            }`}
            title={`Select all ${stat.label} (${stat.selectedCount}/${stat.totalCount} selected)`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{stat.label}</span>
            <span
              className={`rounded px-1 text-[10px] font-bold ${
                active ? 'bg-white/80 dark:bg-slate-800' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
              }`}
            >
              {stat.selectedCount > 0 ? `${stat.selectedCount}/` : ''}
              {stat.totalCount}
            </span>
          </button>
        )
      })}
    </div>
  )
}
