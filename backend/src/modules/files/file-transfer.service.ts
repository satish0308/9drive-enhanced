import { google } from 'googleapis'
import { Readable } from 'node:stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { ConnectedAccount, File } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder, ensureGoogleSubfolder, syncGoogleQuota } from '../google/google.service.js'
import { getS3ConfigForAccount, createS3Client, uploadS3Object, deleteS3Object, buildS3ObjectKey, syncS3Quota } from '../s3/s3.service.js'
import { googleDownloadExportMimeTypes, withExtension } from './stream-google-file.js'
import { createAuditLog } from '../../utils/audit.js'

export type TransferResult = {
  file: File & {
    connectedAccount: { id: string; email: string; provider: string }
    folder: { id: string; name: string } | null
  }
}

export async function transferFile(fileId: string, targetAccountId: string, userId: string): Promise<TransferResult> {
  const file = await prisma.file.findFirstOrThrow({
    where: { id: fileId, userId, status: 'active' },
    include: { connectedAccount: true, folder: true },
  })

  const targetAccount = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: targetAccountId, userId, status: 'connected' },
    include: { storageAccount: true },
  })

  if (file.connectedAccountId === targetAccount.id) {
    throw new Error('File is already stored on this storage account.')
  }

  // Quota check
  if (targetAccount.storageAccount?.availableBytes !== null && targetAccount.storageAccount?.availableBytes !== undefined) {
    if (targetAccount.storageAccount.availableBytes < file.sizeBytes) {
      throw new Error('Target storage account does not have enough available space.')
    }
  }

  const sourceAccount = file.connectedAccount
  let sourceStream: Readable
  let targetMimeType = file.mimeType
  let targetFileName = file.name
  let newSizeBytes = file.sizeBytes

  // 1. Read Stream from source provider
  if (sourceAccount.provider === 'google_drive') {
    const sourceAuth = await getAuthedGoogleClient(sourceAccount)
    const sourceDrive = google.drive({ version: 'v3', auth: sourceAuth })
    const exportTarget = googleDownloadExportMimeTypes[file.mimeType]

    if (exportTarget) {
      targetMimeType = exportTarget.mimeType
      targetFileName = withExtension(file.name, exportTarget.extension)
      const exportRes = await sourceDrive.files.export(
        { fileId: file.providerFileId, mimeType: exportTarget.mimeType },
        { responseType: 'stream' }
      )
      sourceStream = exportRes.data as Readable
    } else {
      const getRes = await sourceDrive.files.get(
        { fileId: file.providerFileId, alt: 'media' },
        { responseType: 'stream' }
      )
      sourceStream = getRes.data as Readable
    }
  } else if (sourceAccount.provider === 's3') {
    const sourceConfig = await getS3ConfigForAccount(sourceAccount.id, userId)
    const sourceClient = createS3Client(sourceConfig)
    const getRes = await sourceClient.send(new GetObjectCommand({
      Bucket: sourceConfig.bucket,
      Key: file.providerFileId,
    }))
    sourceStream = getRes.Body as Readable
  } else {
    throw new Error(`Unsupported source provider: ${sourceAccount.provider}`)
  }

  // 2. Upload Stream to target provider
  let newProviderFileId: string
  if (targetAccount.provider === 'google_drive') {
    const targetAuth = await getAuthedGoogleClient(targetAccount)
    const targetDrive = google.drive({ version: 'v3', auth: targetAuth })
    const appFolderId = await ensureGoogleAppFolder(targetAccount)
    let targetParentId = appFolderId

    if (file.folder) {
      targetParentId = await ensureGoogleSubfolder(targetAccount, file.folder.name, appFolderId)
    }

    const uploaded = await targetDrive.files.create({
      requestBody: {
        name: targetFileName,
        parents: [targetParentId],
      },
      media: {
        mimeType: targetMimeType,
        body: sourceStream,
      },
      fields: 'id, name, size',
    })

    if (!uploaded.data.id) {
      throw new Error('Google Drive upload failed to return a file ID.')
    }
    newProviderFileId = uploaded.data.id
    if (uploaded.data.size) {
      newSizeBytes = BigInt(uploaded.data.size)
    }
  } else if (targetAccount.provider === 's3') {
    const targetConfig = await getS3ConfigForAccount(targetAccount.id, userId)
    newProviderFileId = buildS3ObjectKey(targetConfig, userId, file.id, targetFileName)
    await uploadS3Object(targetConfig, newProviderFileId, sourceStream, targetMimeType)
  } else {
    throw new Error(`Unsupported target provider: ${targetAccount.provider}`)
  }

  // 3. Delete from source provider (safe: only runs after target upload succeeds)
  try {
    if (sourceAccount.provider === 'google_drive') {
      const sourceAuth = await getAuthedGoogleClient(sourceAccount)
      const sourceDrive = google.drive({ version: 'v3', auth: sourceAuth })
      await sourceDrive.files.delete({ fileId: file.providerFileId })
    } else if (sourceAccount.provider === 's3') {
      await deleteS3Object(file)
    }
  } catch (deleteError) {
    console.warn(`[transfer] Upload succeeded but failed to delete file ${file.providerFileId} from source:`, deleteError)
  }

  // 4. Update database record
  const updatedFile = await prisma.file.update({
    where: { id: file.id },
    data: {
      connectedAccountId: targetAccount.id,
      provider: targetAccount.provider,
      providerFileId: newProviderFileId,
      name: targetFileName,
      mimeType: targetMimeType,
      sizeBytes: newSizeBytes,
    },
    include: {
      connectedAccount: { select: { id: true, email: true, provider: true } },
      folder: { select: { id: true, name: true } },
    },
  })

  // 5. Trigger background quota updates for both accounts
  if (sourceAccount.provider === 's3') syncS3Quota(sourceAccount.id).catch(() => undefined)
  else syncGoogleQuota(sourceAccount.id).catch(() => undefined)

  if (targetAccount.provider === 's3') syncS3Quota(targetAccount.id).catch(() => undefined)
  else syncGoogleQuota(targetAccount.id).catch(() => undefined)

  // 6. Audit log
  await createAuditLog(userId, 'TRANSFER_FILE', 'file', file.id, {
    fromAccountId: sourceAccount.id,
    fromAccountEmail: sourceAccount.email,
    toAccountId: targetAccount.id,
    toAccountEmail: targetAccount.email,
    fileName: targetFileName,
    sizeBytes: newSizeBytes.toString(),
  })

  return {
    file: updatedFile,
  }
}

export async function transferFolder(folderId: string, targetAccountId: string, userId: string) {
  const folder = await prisma.folder.findFirstOrThrow({
    where: { id: folderId, userId, deletedAt: null },
  })

  const targetAccount = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: targetAccountId, userId, status: 'connected' },
  })

  // Find all nested folders recursively
  const allUserFolders = await prisma.folder.findMany({
    where: { userId, deletedAt: null },
  })
  const folderIdsToProcess = new Set<string>([folder.id])
  let added = true
  while (added) {
    added = false
    for (const f of allUserFolders) {
      if (f.parentId && folderIdsToProcess.has(f.parentId) && !folderIdsToProcess.has(f.id)) {
        folderIdsToProcess.add(f.id)
        added = true
      }
    }
  }

  // Find all files belonging to this folder tree
  const filesToTransfer = await prisma.file.findMany({
    where: {
      userId,
      folderId: { in: Array.from(folderIdsToProcess) },
      status: 'active',
    },
  })

  const results: Array<{ fileId: string; fileName: string; success: boolean; error?: string }> = []
  for (const file of filesToTransfer) {
    if (file.connectedAccountId === targetAccountId) {
      results.push({ fileId: file.id, fileName: file.name, success: true })
      continue
    }
    try {
      await transferFile(file.id, targetAccountId, userId)
      results.push({ fileId: file.id, fileName: file.name, success: true })
    } catch (err: any) {
      console.error(`[transferFolder] Failed to transfer file ${file.name} (${file.id}):`, err)
      results.push({ fileId: file.id, fileName: file.name, success: false, error: err.message || 'Transfer failed' })
    }
  }

  // Update folder connectedAccountId in database
  await prisma.folder.updateMany({
    where: { id: { in: Array.from(folderIdsToProcess) } },
    data: { connectedAccountId: targetAccountId },
  })

  // If target is Google Drive, ensure folder inside 9drive
  if (targetAccount.provider === 'google_drive') {
    try {
      const appFolderId = await ensureGoogleAppFolder(targetAccount)
      const targetFolderId = await ensureGoogleSubfolder(targetAccount, folder.name, appFolderId)
      await prisma.folder.update({
        where: { id: folder.id },
        data: { providerFolderId: targetFolderId },
      })
    } catch (e) {
      console.error('[transferFolder] Failed to ensure folder on target Google Drive:', e)
    }
  }

  await createAuditLog(userId, 'TRANSFER_FOLDER', 'folder', folder.id, {
    toAccountId: targetAccount.id,
    toAccountEmail: targetAccount.email,
    folderName: folder.name,
    transferredCount: results.filter((r) => r.success).length,
    failedCount: results.filter((r) => !r.success).length,
  })

  return {
    folderId: folder.id,
    transferredCount: results.filter((r) => r.success).length,
    failedCount: results.filter((r) => !r.success).length,
    results,
  }
}
