import { useState, useEffect } from 'react'
import { Check, Palette, Sparkles, Loader2, Folder } from 'lucide-react'
import { DummyModal } from './DummyModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import type { ConnectedAccountInfo } from './TransferModal'

export const PRESET_ACCOUNT_COLORS = [
  { label: 'Google Blue', hex: '#3b82f6', bg: 'bg-blue-500' },
  { label: 'Emerald Green', hex: '#10b981', bg: 'bg-emerald-500' },
  { label: 'Violet Purple', hex: '#8b5cf6', bg: 'bg-purple-500' },
  { label: 'Warm Amber', hex: '#f59e0b', bg: 'bg-amber-500' },
  { label: 'Vibrant Rose', hex: '#f43f5e', bg: 'bg-rose-500' },
  { label: 'Cyan Ocean', hex: '#06b6d4', bg: 'bg-cyan-500' },
  { label: 'Deep Indigo', hex: '#6366f1', bg: 'bg-indigo-500' },
  { label: 'Hot Pink', hex: '#ec4899', bg: 'bg-pink-500' },
  { label: 'Teal Mint', hex: '#14b8a6', bg: 'bg-teal-500' },
  { label: 'Slate Gray', hex: '#64748b', bg: 'bg-slate-500' },
]

export function getAccountColor(account?: { color?: string | null; id?: string; email?: string } | null, fallbackIndex = 0): string {
  if (account?.color) return account.color
  const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#6366f1', '#14b8a6']
  if (!account?.email && !account?.id) return colors[fallbackIndex % colors.length]
  const str = account.email || account.id || ''
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return colors[Math.abs(hash) % colors.length]
}

type AccountColorPickerModalProps = {
  open: boolean
  account: ConnectedAccountInfo | null
  onClose: () => void
  onColorSaved: (accountId: string, newColor: string) => void
}

export function AccountColorPickerModal({
  open,
  account,
  onClose,
  onColorSaved,
}: AccountColorPickerModalProps) {
  const [selectedColor, setSelectedColor] = useState('#3b82f6')
  const [updateExisting, setUpdateExisting] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (account) {
      setSelectedColor(getAccountColor(account))
      setError('')
      setUpdateExisting(true)
    }
  }, [account, open])

  if (!open || !account) return null

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      await apiFetch(`/connected-accounts/${account!.id}/color`, {
        method: 'PATCH',
        body: JSON.stringify({
          color: selectedColor,
          updateExistingFolders: updateExisting,
        }),
      })
      onColorSaved(account!.id, selectedColor)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update folder color')
    } finally {
      setSaving(false)
    }
  }

  return (
    <DummyModal
      open={open}
      onClose={onClose}
      title="Choose Drive Folder Color"
      description={`Set the primary folder and theme color for ${account.email}`}
    >
      <div className="space-y-5 pt-2">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-600">
            {error}
          </div>
        )}

        {/* Account Info Pill */}
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white font-bold text-sm shadow-sm"
            style={{ backgroundColor: selectedColor }}
          >
            <Palette className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-slate-900">{account.email}</p>
            <p className="text-xs text-slate-500 capitalize">
              {account.provider === 'google_drive' ? 'Google Drive Account' : 'Storage Account'}
            </p>
          </div>
        </div>

        {/* Preset Palettes */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Preset Palette
          </label>
          <div className="mt-2.5 grid grid-cols-5 gap-2 sm:grid-cols-5">
            {PRESET_ACCOUNT_COLORS.map((preset) => {
              const isSelected = selectedColor.toLowerCase() === preset.hex.toLowerCase()
              return (
                <button
                  key={preset.hex}
                  type="button"
                  onClick={() => setSelectedColor(preset.hex)}
                  className={`group relative flex flex-col items-center gap-1 rounded-xl border p-2 text-center transition-all ${
                    isSelected
                      ? 'border-slate-900 bg-slate-50 ring-2 ring-slate-900/10 dark:border-white dark:bg-slate-800'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg shadow-sm transition-transform group-hover:scale-105"
                    style={{ backgroundColor: preset.hex }}
                  >
                    {isSelected && <Check className="h-4 w-4 text-white drop-shadow-sm" />}
                  </span>
                  <span className="text-[10px] font-medium text-slate-600 line-clamp-1">
                    {preset.label.split(' ')[0]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Custom Color Input */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Custom Hex Color
          </label>
          <div className="mt-2 flex items-center gap-2">
            <Input
              type="color"
              value={selectedColor}
              onChange={(e) => setSelectedColor(e.target.value)}
              className="h-10 w-14 cursor-pointer p-1 rounded-xl"
            />
            <Input
              type="text"
              value={selectedColor}
              onChange={(e) => setSelectedColor(e.target.value)}
              placeholder="#3b82f6"
              className="flex-1 font-mono text-sm uppercase"
            />
          </div>
        </div>

        {/* Live Preview Box */}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Preview on Folders &amp; Badges
          </label>
          <div className="mt-2 flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-3 shadow-inner">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-xl border shadow-sm transition-colors"
              style={{
                backgroundColor: `${selectedColor}15`,
                borderColor: `${selectedColor}40`,
                color: selectedColor,
              }}
            >
              <Folder className="h-6 w-6 fill-current" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-800">Sample Folder Name</p>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border"
                  style={{
                    backgroundColor: `${selectedColor}15`,
                    borderColor: `${selectedColor}40`,
                    color: selectedColor,
                  }}
                >
                  ● {account.email}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Checkbox: Update existing folders */}
        <label className="flex items-start gap-2.5 cursor-pointer rounded-xl border border-slate-200 p-3 hover:bg-slate-50">
          <input
            type="checkbox"
            checked={updateExisting}
            onChange={(e) => setUpdateExisting(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 accent-blue-600"
          />
          <div className="text-xs text-slate-600">
            <span className="font-semibold text-slate-900 block">
              Apply to all existing folders in this account
            </span>
            <span>
              Instantly updates the color of all folders previously imported or created under this Google Drive account.
            </span>
          </div>
        </label>

        {/* Modal Actions */}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="outline" size="sm" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" type="button" onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving...
              </>
            ) : (
              <>
                <Sparkles className="mr-1.5 h-4 w-4" /> Save Folder Color
              </>
            )}
          </Button>
        </div>
      </div>
    </DummyModal>
  )
}
