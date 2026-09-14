import { google } from 'googleapis'
import { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder, ensureGoogleSubfolder, syncGoogleQuota } from '../google/google.service.js'
import { getS3ConfigForAccount, createS3Client, uploadS3Object, deleteS3Object, buildS3ObjectKey, syncS3Quota } from '../s3/s3.service.js'
import { createAuditLog } from '../../utils/audit.js'

// In-memory cache for Google Drive CDN thumbnail links (TTL 45 minutes)
type ThumbnailCacheEntry = { url: string; expiresAt: number }
const thumbnailCache = new Map<string, ThumbnailCacheEntry>()

export interface PhotoListParams {
  userId: string
  accountId?: string
  accountIds?: string[]
  mediaType?: 'all' | 'image' | 'video'
  search?: string
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
}

export interface PhotoDetailsResult {
  file: {
    id: string
    name: string
    mimeType: string
    sizeBytes: string
    checksum: string | null
    createdAt: string
    updatedAt: string
    folderId: string | null
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
  }
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

export interface TransferPhotosParams {
  userId: string
  fileIds: string[]
  targetAccountId: string
  targetFolderId?: string | null
  mode: 'copy' | 'move'
  verifyChecksum?: boolean
}

export interface TransferPhotoResult {
  fileId: string
  fileName: string
  newFileId?: string
  targetAccountId: string
  targetFolderId?: string | null
  mode: 'copy' | 'move'
  checksum?: string
  sizeBytes?: string
  success: boolean
  error?: string
}

export async function listPhotos(params: PhotoListParams) {
  const {
    userId,
    accountId,
    accountIds,
    mediaType = 'all',
    search,
    startDate,
    endDate,
    page = 1,
    limit = 50,
  } = params

  const targetAccountIds = accountIds && accountIds.length > 0
    ? accountIds
    : accountId
    ? [accountId]
    : undefined

  const where: any = {
    userId,
    status: 'active',
    OR: [
      { mimeType: { startsWith: 'image/' } },
      { mimeType: { startsWith: 'video/' } },
    ],
    ...(mediaType === 'image' ? { mimeType: { startsWith: 'image/' } } : {}),
    ...(mediaType === 'video' ? { mimeType: { startsWith: 'video/' } } : {}),
    ...(targetAccountIds ? { connectedAccountId: { in: targetAccountIds } } : {}),
    ...(search ? { name: { contains: search } } : {}),
    ...(startDate || endDate ? {
      createdAt: {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {}),
      },
    } : {}),
  }

  const skip = (page - 1) * limit
  const [totalCount, files] = await Promise.all([
    prisma.file.count({ where }),
    prisma.file.findMany({
      where,
      include: {
        connectedAccount: {
          select: { id: true, email: true, provider: true, color: true, displayName: true },
        },
        folder: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ])

  return {
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
    photos: files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes.toString(),
      checksum: file.checksum,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
      folderId: file.folderId,
      provider: file.provider,
      providerFileId: file.providerFileId,
      connectedAccount: file.connectedAccount,
      folder: file.folder,
      thumbnailUrl: `/photos/${file.id}/thumbnail`,
      streamUrl: `/photos/${file.id}/stream`,
    })),
  }
}

export async function getPhotoDetails(fileId: string, userId: string): Promise<PhotoDetailsResult> {
  const file = await prisma.file.findFirstOrThrow({
    where: { id: fileId, userId, status: 'active' },
    include: {
      connectedAccount: {
        select: { id: true, email: true, provider: true, color: true, displayName: true },
      },
      folder: {
        select: { id: true, name: true },
      },
    },
  })

  const baseResult: PhotoDetailsResult = {
    file: {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes.toString(),
      checksum: file.checksum,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
      folderId: file.folderId,
      connectedAccount: file.connectedAccount,
      folder: file.folder,
    },
  }

  if (file.provider === 'google_drive') {
    try {
      const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: file.connectedAccountId } })
      const auth = await getAuthedGoogleClient(account)
      const drive = google.drive({ version: 'v3', auth })
      const meta = await drive.files.get({
        fileId: file.providerFileId,
        fields: 'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,thumbnailLink,imageMediaMetadata,videoMediaMetadata',
      })

      const data = meta.data
      if (data.md5Checksum && !file.checksum) {
        await prisma.file.update({
          where: { id: file.id },
          data: { checksum: data.md5Checksum },
        }).catch(() => undefined)
        baseResult.file.checksum = data.md5Checksum
      }

      if (data.thumbnailLink) {
        thumbnailCache.set(file.id, {
          url: data.thumbnailLink,
          expiresAt: Date.now() + 45 * 60 * 1000,
        })
        baseResult.thumbnailUrl = data.thumbnailLink
      }

      if (data.imageMediaMetadata) {
        const imm = data.imageMediaMetadata
        baseResult.dimensions = {
          width: imm.width ?? 0,
          height: imm.height ?? 0,
          rotation: imm.rotation ?? 0,
        }
        baseResult.camera = {
          make: imm.cameraMake ?? undefined,
          model: imm.cameraModel ?? undefined,
          focalLength: imm.focalLength ?? undefined,
          aperture: imm.aperture ?? undefined,
          iso: imm.isoSpeed ?? undefined,
          exposureTime: imm.exposureTime ?? undefined,
        }
      }

      if (data.videoMediaMetadata) {
        const vmm = data.videoMediaMetadata
        baseResult.dimensions = {
          width: vmm.width ?? 0,
          height: vmm.height ?? 0,
        }
        baseResult.video = {
          durationMillis: vmm.durationMillis ?? undefined,
        }
      }

      baseResult.createdTime = data.createdTime ?? undefined
      baseResult.modifiedTime = data.modifiedTime ?? undefined
    } catch (err) {
      console.warn(`[getPhotoDetails] Failed to fetch Google Drive metadata for ${file.id}:`, err)
    }
  }

  return baseResult
}

export async function getPhotoThumbnailUrl(fileId: string, userId: string, size = 400): Promise<string | null> {
  const cached = thumbnailCache.get(fileId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url.replace(/=s\d+/, `=s${size}`)
  }

  const file = await prisma.file.findFirst({
    where: { id: fileId, userId, status: 'active' },
    include: { connectedAccount: true },
  })

  if (!file || file.provider !== 'google_drive') return null

  try {
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    const meta = await drive.files.get({
      fileId: file.providerFileId,
      fields: 'thumbnailLink',
    })

    const rawUrl = meta.data.thumbnailLink
    if (rawUrl) {
      thumbnailCache.set(fileId, {
        url: rawUrl,
        expiresAt: Date.now() + 45 * 60 * 1000,
      })
      return rawUrl.replace(/=s\d+/, `=s${size}`)
    }
  } catch (err) {
    console.warn(`[getPhotoThumbnailUrl] Failed to get thumbnail for ${fileId}:`, err)
  }

  return null
}

export async function transferPhotos(params: TransferPhotosParams): Promise<{
  transferredCount: number
  failedCount: number
  results: TransferPhotoResult[]
}> {
  const {
    userId,
    fileIds,
    targetAccountId,
    targetFolderId,
    mode,
    verifyChecksum = true,
  } = params

  if (!fileIds || fileIds.length === 0) {
    throw new Error('No photos selected for transfer.')
  }

  const targetAccount = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: targetAccountId, userId, status: 'connected' },
    include: { storageAccount: true },
  })

  const files = await prisma.file.findMany({
    where: { id: { in: fileIds }, userId, status: 'active' },
    include: { connectedAccount: true, folder: true },
  })

  if (files.length === 0) {
    throw new Error('None of the selected photos were found or active.')
  }

  // Quota check: only needed if copying, or moving to a different account
  const isAllSameAccount = files.every((f) => f.connectedAccountId === targetAccount.id)
  if (!(isAllSameAccount && mode === 'move')) {
    const totalBytesNeeded = files.reduce((acc, f) => acc + f.sizeBytes, 0n)
    if (
      targetAccount.storageAccount?.availableBytes !== null &&
      targetAccount.storageAccount?.availableBytes !== undefined
    ) {
      if (targetAccount.storageAccount.availableBytes < totalBytesNeeded) {
        throw new Error(
          `Insufficient storage space on target account. Required: ${totalBytesNeeded} bytes, Available: ${targetAccount.storageAccount.availableBytes} bytes.`
        )
      }
    }
  }

  // Resolve target Google Drive destination folder ID and target DB folder ID
  let targetDriveFolderId: string = 'root'
  let dbTargetFolderId: string | null = null

  if (targetAccount.provider === 'google_drive') {
    if (!targetFolderId || targetFolderId === 'root') {
      targetDriveFolderId = 'root'
      dbTargetFolderId = null
    } else if (targetFolderId === 'app' || targetFolderId === '9drive') {
      targetDriveFolderId = await ensureGoogleAppFolder(targetAccount)
      dbTargetFolderId = null
    } else {
      // Check if targetFolderId is a DB folder ID
      const dbFolder = await prisma.folder.findFirst({
        where: { id: targetFolderId, userId, deletedAt: null },
      })
      if (dbFolder) {
        dbTargetFolderId = dbFolder.id
        if (dbFolder.providerFolderId) {
          targetDriveFolderId = dbFolder.providerFolderId
        } else {
          // Self-heal folder in target drive
          const appFolderId = await ensureGoogleAppFolder(targetAccount)
          targetDriveFolderId = await ensureGoogleSubfolder(targetAccount, dbFolder.name, appFolderId)
          await prisma.folder.update({
            where: { id: dbFolder.id },
            data: { providerFolderId: targetDriveFolderId, connectedAccountId: targetAccount.id },
          }).catch(() => undefined)
        }
      } else {
        // targetFolderId is a Google Drive provider folder ID directly
        targetDriveFolderId = targetFolderId
        const existing = await prisma.folder.findFirst({
          where: { providerFolderId: targetFolderId, userId, deletedAt: null },
        })
        if (existing) dbTargetFolderId = existing.id
      }
    }
  }

  const results: TransferPhotoResult[] = []

  for (const file of files) {
    try {
      // If transferring within the same account and same folder, skip
      if (file.connectedAccountId === targetAccount.id && file.folderId === dbTargetFolderId) {
        results.push({
          fileId: file.id,
          fileName: file.name,
          targetAccountId: targetAccount.id,
          targetFolderId: dbTargetFolderId,
          mode,
          success: true,
          error: 'Photo already resides in the target folder.',
        })
        continue
      }

      // Step 1: Read source metadata and binary stream with ZERO quality loss
      let sourceStream: Readable
      let sourceMd5: string | undefined = file.checksum ?? undefined
      let sourceCreatedTime: string | undefined
      let sourceModifiedTime: string | undefined
      let sourceSize = file.sizeBytes

      const sourceAccount = file.connectedAccount
      if (sourceAccount.provider === 'google_drive') {
        const sourceAuth = await getAuthedGoogleClient(sourceAccount)
        const sourceDrive = google.drive({ version: 'v3', auth: sourceAuth })

        // Fetch source Google Drive metadata for exact MD5 & timestamps
        const metaRes = await sourceDrive.files.get({
          fileId: file.providerFileId,
          fields: 'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime',
        })
        if (metaRes.data.md5Checksum) sourceMd5 = metaRes.data.md5Checksum
        if (metaRes.data.size) sourceSize = BigInt(metaRes.data.size)
        sourceCreatedTime = metaRes.data.createdTime ?? file.createdAt.toISOString()
        sourceModifiedTime = metaRes.data.modifiedTime ?? file.updatedAt.toISOString()

        // Fetch raw byte stream (alt=media) with ZERO compression/transcoding
        const streamRes = await sourceDrive.files.get(
          { fileId: file.providerFileId, alt: 'media' },
          { responseType: 'stream' }
        )
        sourceStream = streamRes.data as Readable
      } else if (sourceAccount.provider === 's3') {
        const s3Config = await getS3ConfigForAccount(sourceAccount.id, userId)
        const s3Client = createS3Client(s3Config)
        const getRes = await s3Client.send(
          new (await import('@aws-sdk/client-s3')).GetObjectCommand({
            Bucket: s3Config.bucket,
            Key: file.providerFileId,
          })
        )
        sourceStream = getRes.Body as Readable
      } else {
        throw new Error(`Unsupported source provider: ${sourceAccount.provider}`)
      }

      // Step 2: Upload Stream to Target Google Drive with metadata preservation
      let newProviderFileId: string
      let targetMd5: string | undefined
      let targetSize: bigint = sourceSize

      if (targetAccount.provider === 'google_drive') {
        const targetAuth = await getAuthedGoogleClient(targetAccount)
        const targetDrive = google.drive({ version: 'v3', auth: targetAuth })

        // Upload stream byte-for-byte, preserving createdTime and modifiedTime
        const uploadRes = await targetDrive.files.create({
          requestBody: {
            name: file.name,
            parents: [targetDriveFolderId],
            createdTime: sourceCreatedTime,
            modifiedTime: sourceModifiedTime,
          },
          media: {
            mimeType: file.mimeType,
            body: sourceStream,
          },
          fields: 'id,name,size,md5Checksum,createdTime,modifiedTime',
        })

        if (!uploadRes.data.id) {
          throw new Error('Destination Google Drive failed to return a file ID.')
        }

        newProviderFileId = uploadRes.data.id
        targetMd5 = uploadRes.data.md5Checksum ?? undefined
        if (uploadRes.data.size) {
          targetSize = BigInt(uploadRes.data.size)
        }

        // Step 3: Strict Bit-for-Bit Integrity Verification (Zero Data Loss)
        if (verifyChecksum && sourceMd5 && targetMd5) {
          if (sourceMd5.toLowerCase() !== targetMd5.toLowerCase() || targetSize !== sourceSize) {
            // Checksum mismatch: Discard incomplete target file and abort to prevent data loss
            await targetDrive.files.delete({ fileId: newProviderFileId }).catch(() => undefined)
            throw new Error(
              `Integrity verification failed: MD5 mismatch (Source: ${sourceMd5}, Target: ${targetMd5}). Target file deleted; source left untouched.`
            )
          }
        }
      } else if (targetAccount.provider === 's3') {
        const s3Config = await getS3ConfigForAccount(targetAccount.id, userId)
        newProviderFileId = buildS3ObjectKey(s3Config, userId, file.id, file.name)
        await uploadS3Object(s3Config, newProviderFileId, sourceStream, file.mimeType)
      } else {
        throw new Error(`Unsupported target provider: ${targetAccount.provider}`)
      }

      // Step 4: Finalize database records and source file handling
      let finalFileId = file.id

      if (mode === 'move') {
        // Safe Move: Delete / Trash source file ONLY AFTER verified upload
        try {
          if (sourceAccount.provider === 'google_drive') {
            const sourceAuth = await getAuthedGoogleClient(sourceAccount)
            const sourceDrive = google.drive({ version: 'v3', auth: sourceAuth })
            await sourceDrive.files.update({
              fileId: file.providerFileId,
              requestBody: { trashed: true },
            })
          } else if (sourceAccount.provider === 's3') {
            await deleteS3Object(file)
          }
        } catch (trashErr) {
          console.warn(`[transferPhotos] Upload succeeded but failed to trash source file ${file.id}:`, trashErr)
        }

        // Mark source file as deleted in DB
        await prisma.file.update({
          where: { id: file.id },
          data: { status: 'deleted', deletedAt: new Date() },
        })

        // Create new active record for moved photo on target account
        const newFile = await prisma.file.create({
          data: {
            userId,
            connectedAccountId: targetAccount.id,
            provider: targetAccount.provider,
            providerFileId: newProviderFileId,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: targetSize,
            checksum: targetMd5 ?? sourceMd5,
            folderId: dbTargetFolderId,
            status: 'active',
          },
        })
        finalFileId = newFile.id

        await createAuditLog(userId, 'PHOTO_TRANSFER_MOVE', 'file', newFile.id, {
          fromAccountId: sourceAccount.id,
          toAccountId: targetAccount.id,
          fileName: file.name,
          checksum: targetMd5 ?? sourceMd5,
          mode: 'move',
        })
      } else {
        // Mode === 'copy': Source file remains 100% active and untouched
        const newFile = await prisma.file.create({
          data: {
            userId,
            connectedAccountId: targetAccount.id,
            provider: targetAccount.provider,
            providerFileId: newProviderFileId,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: targetSize,
            checksum: targetMd5 ?? sourceMd5,
            folderId: dbTargetFolderId,
            status: 'active',
          },
        })
        finalFileId = newFile.id

        await createAuditLog(userId, 'PHOTO_TRANSFER_COPY', 'file', newFile.id, {
          fromAccountId: sourceAccount.id,
          toAccountId: targetAccount.id,
          fileName: file.name,
          checksum: targetMd5 ?? sourceMd5,
          mode: 'copy',
        })
      }

      results.push({
        fileId: file.id,
        fileName: file.name,
        newFileId: finalFileId,
        targetAccountId: targetAccount.id,
        targetFolderId: dbTargetFolderId,
        mode,
        checksum: targetMd5 ?? sourceMd5,
        sizeBytes: targetSize.toString(),
        success: true,
      })
    } catch (err: any) {
      console.error(`[transferPhotos] Error transferring file ${file.name} (${file.id}):`, err)
      results.push({
        fileId: file.id,
        fileName: file.name,
        targetAccountId: targetAccount.id,
        targetFolderId: dbTargetFolderId,
        mode,
        success: false,
        error: err.message || 'Transfer failed',
      })
    }
  }

  // Trigger quota sync for involved accounts in the background
  const sourceAccountIds = new Set(files.map((f) => f.connectedAccountId))
  for (const accId of sourceAccountIds) {
    syncGoogleQuota(accId).catch(() => undefined)
  }
  syncGoogleQuota(targetAccount.id).catch(() => undefined)

  return {
    transferredCount: results.filter((r) => r.success).length,
    failedCount: results.filter((r) => !r.success).length,
    results,
  }
}

export async function getTargetAccountFolders(accountId: string, userId: string) {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId, status: 'connected' },
  })

  // 1. Get virtual folders stored in 9Drive for this account
  const dbFolders = await prisma.folder.findMany({
    where: { userId, deletedAt: null, connectedAccountId: account.id },
    select: { id: true, name: true, parentId: true, providerFolderId: true },
    orderBy: { name: 'asc' },
  })

  // 2. If Google Drive, also fetch top-level folders directly from Google Drive API
  let driveFolders: Array<{ id: string; name: string; isDriveNative: boolean }> = []
  if (account.provider === 'google_drive') {
    try {
      const auth = await getAuthedGoogleClient(account)
      const drive = google.drive({ version: 'v3', auth })
      const res = await drive.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name, parents)',
        pageSize: 50,
      })
      driveFolders = (res.data.files ?? []).map((f) => ({
        id: f.id!,
        name: f.name!,
        isDriveNative: true,
      }))
    } catch (err) {
      console.warn(`[getTargetAccountFolders] Failed to list drive folders for ${accountId}:`, err)
    }
  }

  return {
    accountId,
    accountEmail: account.email,
    dbFolders,
    driveFolders,
  }
}

export async function createTargetAccountFolder(
  accountId: string,
  folderName: string,
  parentFolderId: string | null,
  userId: string
) {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId, status: 'connected' },
  })

  if (!folderName.trim()) {
    throw new Error('Folder name cannot be empty.')
  }

  let providerFolderId: string | null = null
  if (account.provider === 'google_drive') {
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    let parentGoogleId = parentFolderId || 'root'
    if (parentFolderId && parentFolderId !== 'root') {
      const parentDbFolder = await prisma.folder.findFirst({
        where: { id: parentFolderId, userId, deletedAt: null },
      })
      if (parentDbFolder?.providerFolderId) {
        parentGoogleId = parentDbFolder.providerFolderId
      }
    }

    const driveFolder = await drive.files.create({
      requestBody: {
        name: folderName.trim(),
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentGoogleId],
      },
      fields: 'id',
    })
    providerFolderId = driveFolder.data.id ?? null
  }

  const folder = await prisma.folder.create({
    data: {
      userId,
      connectedAccountId: account.id,
      name: folderName.trim(),
      color: '#3b82f6',
      parentId: parentFolderId === 'root' ? null : parentFolderId,
      providerFolderId,
    },
  })

  return folder
}

// ==========================================
// Google Photos Picker API Integration (2025+)
// ==========================================

export async function createGooglePickerSession(accountId: string, userId: string) {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId, status: 'connected', provider: 'google_drive' },
  })

  const auth = await getAuthedGoogleClient(account)
  const token = await auth.getAccessToken()
  if (!token.token) {
    throw new Error('Could not obtain Google access token.')
  }

  const res = await fetch('https://photospicker.googleapis.com/v1/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    try {
      const parsed = JSON.parse(errText)
      const errorObj = parsed.error || {}
      const details = errorObj.details || []
      const serviceDisabled = details.find((d: any) => d.reason === 'SERVICE_DISABLED' || d.metadata?.activationUrl)
      if (serviceDisabled || errorObj.message?.includes('has not been used in project') || errorObj.message?.includes('disabled')) {
        const activationUrl = serviceDisabled?.metadata?.activationUrl
          || 'https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview?project=866882368661'
        throw new Error(`GOOGLE_PHOTOS_PICKER_API_DISABLED: ${activationUrl}`)
      }
      if (errorObj.message) {
        throw new Error(errorObj.message)
      }
    } catch (e: any) {
      if (e.message.startsWith('GOOGLE_PHOTOS_PICKER_API_DISABLED:')) throw e
    }
    throw new Error(`Google Photos Picker error (${res.status}): ${errText}`)
  }

  const data = await res.json() as { id: string; pickerUri: string; mediaItemsSet?: boolean }
  return {
    sessionId: data.id,
    pickerUri: data.pickerUri,
  }
}

export async function pollGooglePickerSession(accountId: string, sessionId: string, userId: string) {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId, status: 'connected', provider: 'google_drive' },
  })

  const auth = await getAuthedGoogleClient(account)
  const token = await auth.getAccessToken()
  if (!token.token) throw new Error('Could not obtain Google access token.')

  const sessionRes = await fetch(`https://photospicker.googleapis.com/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token.token}` },
  })

  if (!sessionRes.ok) {
    const errText = await sessionRes.text().catch(() => sessionRes.statusText)
    throw new Error(`Failed to check Picker session: ${errText}`)
  }

  const sessionData = await sessionRes.json() as { id: string; mediaItemsSet?: boolean }

  if (!sessionData.mediaItemsSet) {
    return { mediaItemsSet: false, items: [] }
  }

  const itemsRes = await fetch(
    `https://photospicker.googleapis.com/v1/mediaItems?sessionId=${sessionId}&pageSize=100`,
    {
      headers: { Authorization: `Bearer ${token.token}` },
    }
  )

  if (!itemsRes.ok) {
    const errText = await itemsRes.text().catch(() => itemsRes.statusText)
    throw new Error(`Failed to fetch picked media items: ${errText}`)
  }

  const itemsData = await itemsRes.json() as {
    mediaItems?: Array<{
      id: string
      baseUrl: string
      mediaFile?: { filename: string; mimeType: string }
    }>
  }

  return {
    mediaItemsSet: true,
    items: (itemsData.mediaItems ?? []).map((item) => ({
      id: item.id,
      baseUrl: (item as any).mediaFile?.baseUrl ?? (item as any).baseUrl,
      name: (item as any).mediaFile?.filename ?? (item as any).filename ?? `Photo_${item.id.slice(0, 8)}.jpg`,
      mimeType: (item as any).mediaFile?.mimeType ?? (item as any).mimeType ?? 'image/jpeg',
    })).filter((item) => Boolean(item.baseUrl)),
  }
}

export async function importPickerItems(params: {
  sourceAccountId: string
  targetAccountId: string
  targetFolderId?: string | null
  items: Array<{ id: string; baseUrl: string; name: string; mimeType: string }>
  userId: string
}) {
  const { sourceAccountId, targetAccountId, targetFolderId, items, userId } = params
  if (!items || items.length === 0) throw new Error('No media items to import.')

  const sourceAccount = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: sourceAccountId, userId, status: 'connected', provider: 'google_drive' },
  })

  const targetAccount = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: targetAccountId, userId, status: 'connected', provider: 'google_drive' },
  })

  const sourceAuth = await getAuthedGoogleClient(sourceAccount)
  const sourceToken = await sourceAuth.getAccessToken()
  if (!sourceToken.token) throw new Error('Could not obtain source Google access token.')

  const targetAuth = await getAuthedGoogleClient(targetAccount)
  const targetDrive = google.drive({ version: 'v3', auth: targetAuth })

  let targetDriveFolderId = 'root'
  let dbTargetFolderId: string | null = null

  if (!targetFolderId || targetFolderId === 'root') {
    targetDriveFolderId = 'root'
  } else if (targetFolderId === 'app' || targetFolderId === '9drive') {
    targetDriveFolderId = await ensureGoogleAppFolder(targetAccount)
  } else {
    const dbFolder = await prisma.folder.findFirst({
      where: { id: targetFolderId, userId, deletedAt: null },
    })
    if (dbFolder) {
      dbTargetFolderId = dbFolder.id
      if (dbFolder.providerFolderId) {
        targetDriveFolderId = dbFolder.providerFolderId
      } else {
        const appFolderId = await ensureGoogleAppFolder(targetAccount)
        targetDriveFolderId = await ensureGoogleSubfolder(targetAccount, dbFolder.name, appFolderId)
        await prisma.folder.update({
          where: { id: dbFolder.id },
          data: { providerFolderId: targetDriveFolderId, connectedAccountId: targetAccount.id },
        }).catch(() => undefined)
      }
    } else {
      targetDriveFolderId = targetFolderId
    }
  }

  const results: Array<{ name: string; success: boolean; error?: string; checksum?: string }> = []

  for (const item of items) {
    try {
      const isVideo = item.mimeType.startsWith('video/')
      const downloadUrl = `${item.baseUrl}=${isVideo ? 'dv' : 'd'}`

      const response = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${sourceToken.token}` },
      })

      if (!response.ok || !response.body) {
        throw new Error(`Failed to stream photo from Google Photos (${response.statusText})`)
      }

      const stream = Readable.fromWeb(response.body as any)

      const uploadRes = await targetDrive.files.create({
        requestBody: {
          name: item.name,
          parents: [targetDriveFolderId],
        },
        media: {
          mimeType: item.mimeType,
          body: stream,
        },
        fields: 'id,name,size,md5Checksum',
      })

      if (!uploadRes.data.id) throw new Error('Upload to target drive failed.')

      const targetSize = BigInt(uploadRes.data.size || 0)
      const targetMd5 = uploadRes.data.md5Checksum ?? null

      await prisma.file.create({
        data: {
          userId,
          connectedAccountId: targetAccount.id,
          provider: 'google_drive',
          providerFileId: uploadRes.data.id,
          name: item.name,
          mimeType: item.mimeType,
          sizeBytes: targetSize,
          checksum: targetMd5,
          folderId: dbTargetFolderId,
          status: 'active',
        },
      })

      results.push({ name: item.name, success: true, checksum: targetMd5 ?? undefined })
    } catch (err: any) {
      console.error(`[importPickerItems] Error importing ${item.name}:`, err)
      results.push({ name: item.name, success: false, error: err.message || 'Import failed' })
    }
  }

  syncGoogleQuota(targetAccount.id).catch(() => undefined)

  return {
    importedCount: results.filter((r) => r.success).length,
    failedCount: results.filter((r) => !r.success).length,
    results,
  }
}
