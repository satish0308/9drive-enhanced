import { google } from 'googleapis'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, syncGoogleQuota, syncGoogleAppFolderFiles } from './google.service.js'
import { createAuditLog } from '../../utils/audit.js'

const folderMimeType = 'application/vnd.google-apps.folder'

export type DriveBrowseItem = {
  id: string
  name: string
  mimeType: string
  sizeBytes: string
  isFolder: boolean
  modifiedTime?: string | null
  iconLink?: string | null
  isImported: boolean
}

export type DriveBrowseResult = {
  currentFolder: {
    id: string
    name: string
    parentFolderId: string | null
  }
  items: DriveBrowseItem[]
}

export async function browseGoogleDrive(accountId: string, userId: string, folderId = 'root'): Promise<DriveBrowseResult> {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId, provider: 'google_drive', status: 'connected' }
  })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })

  let currentFolderName = 'My Drive'
  let parentFolderId: string | null = null

  if (folderId !== 'root') {
    try {
      const meta = await drive.files.get({ fileId: folderId, fields: 'id, name, parents' })
      currentFolderName = meta.data.name || 'Folder'
      parentFolderId = meta.data.parents?.[0] || 'root'
    } catch (err) {
      console.warn('[browseGoogleDrive] Failed to get folder metadata for', folderId, err)
    }
  }

  const query = `'${folderId}' in parents and trashed = false`
  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType, size, modifiedTime, iconLink)',
    orderBy: 'folder,name',
    pageSize: 200,
  })

  const files = res.data.files ?? []
  const itemIds = files.map((f) => f.id).filter((id): id is string => Boolean(id))

  const existingFiles = await prisma.file.findMany({
    where: { userId, connectedAccountId: account.id, providerFileId: { in: itemIds }, status: 'active' },
    select: { providerFileId: true }
  })
  const existingFolders = await prisma.folder.findMany({
    where: { userId, connectedAccountId: account.id, providerFolderId: { in: itemIds }, deletedAt: null },
    select: { providerFolderId: true }
  })

  const importedSet = new Set([
    ...existingFiles.map((f) => f.providerFileId),
    ...existingFolders.map((f) => f.providerFolderId),
  ])

  const items: DriveBrowseItem[] = files.map((f) => ({
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    sizeBytes: f.size ?? '0',
    isFolder: f.mimeType === folderMimeType,
    modifiedTime: f.modifiedTime,
    iconLink: f.iconLink,
    isImported: importedSet.has(f.id!),
  }))

  return {
    currentFolder: {
      id: folderId,
      name: currentFolderName,
      parentFolderId,
    },
    items,
  }
}

export async function importGoogleDriveItems(
  accountId: string,
  userId: string,
  folderIds: string[],
  fileIds: string[],
  targetVirtualFolderId?: string | null,
  maxDepth = 5
) {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId, provider: 'google_drive', status: 'connected' }
  })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })

  let importedFoldersCount = 0
  let importedFilesCount = 0

  async function importFolderRecursive(googleFolderId: string, parentVirtualId: string | null, currentDepth = 0) {
    if (currentDepth > maxDepth) return

    let dbFolder = await prisma.folder.findFirst({
      where: { userId, connectedAccountId: account.id, providerFolderId: googleFolderId, deletedAt: null }
    })

    if (!dbFolder) {
      let name = 'Folder'
      try {
        const meta = await drive.files.get({ fileId: googleFolderId, fields: 'id, name' })
        name = meta.data.name || 'Folder'
      } catch (e) {
        console.warn('[importFolderRecursive] Failed to get name for folder:', googleFolderId, e)
      }

      dbFolder = await prisma.folder.create({
        data: {
          userId,
          name,
          provider: 'google_drive',
          providerFolderId: googleFolderId,
          connectedAccountId: account.id,
          color: account.color || '#3b82f6',
          parentId: parentVirtualId,
        }
      })
      importedFoldersCount += 1
    }

    let pageToken: string | undefined
    do {
      const res = await drive.files.list({
        q: `'${googleFolderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        pageSize: 100,
        pageToken,
      })
      const children = res.data.files ?? []
      const subfolders = children.filter((c) => c.id && c.name && c.mimeType === folderMimeType)
      const fileChildren = children.filter((c) => c.id && c.name && c.mimeType !== folderMimeType)

      // Batch insert non-folder files
      if (fileChildren.length > 0) {
        const batchIds = fileChildren.map((f) => f.id!)
        const existing = await prisma.file.findMany({
          where: { userId, providerFileId: { in: batchIds }, status: 'active' },
          select: { providerFileId: true },
        })
        const existingSet = new Set(existing.map((e) => e.providerFileId))
        const newFiles = fileChildren
          .filter((f) => !existingSet.has(f.id!))
          .map((child) => ({
            userId,
            connectedAccountId: account.id,
            folderId: dbFolder.id,
            provider: 'google_drive',
            providerFileId: child.id!,
            name: child.name!,
            mimeType: child.mimeType || 'application/octet-stream',
            sizeBytes: BigInt(child.size ?? 0),
            status: 'active',
          }))

        if (newFiles.length > 0) {
          await prisma.file.createMany({
            data: newFiles,
            skipDuplicates: true,
          })
          importedFilesCount += newFiles.length
        }
      }

      // Recurse subfolders
      for (const sub of subfolders) {
        if (sub.id) {
          await importFolderRecursive(sub.id, dbFolder.id, currentDepth + 1)
        }
      }

      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
  }

  // 1. Process selected folders
  for (const fId of folderIds) {
    try {
      await importFolderRecursive(fId, targetVirtualFolderId ?? null, 0)
    } catch (err) {
      console.error(`[importGoogleDriveItems] Failed to import folder ${fId}:`, err)
    }
  }

  // 2. Process selected files (batched)
  if (fileIds.length > 0) {
    const existing = await prisma.file.findMany({
      where: { userId, providerFileId: { in: fileIds }, status: 'active' },
      select: { providerFileId: true },
    })
    const existingSet = new Set(existing.map((e) => e.providerFileId))
    const idsToFetch = fileIds.filter((id) => !existingSet.has(id))

    for (const fId of idsToFetch) {
      try {
        const meta = await drive.files.get({ fileId: fId, fields: 'id, name, mimeType, size' })
        if (!meta.data.id || !meta.data.name) continue

        await prisma.file.create({
          data: {
            userId,
            connectedAccountId: account.id,
            folderId: targetVirtualFolderId ?? null,
            provider: 'google_drive',
            providerFileId: meta.data.id,
            name: meta.data.name,
            mimeType: meta.data.mimeType || 'application/octet-stream',
            sizeBytes: BigInt(meta.data.size ?? 0),
            status: 'active',
          }
        })
        importedFilesCount += 1
      } catch (err) {
        console.error(`[importGoogleDriveItems] Failed to import file ${fId}:`, err)
      }
    }
  }

  await syncGoogleQuota(account.id).catch(() => undefined)
  await createAuditLog(userId, 'IMPORT_GOOGLE_DRIVE', 'connected_account', account.id, {
    importedFoldersCount,
    importedFilesCount,
  })

  return {
    importedFoldersCount,
    importedFilesCount,
  }
}

export async function importAllFromGoogleDrive(accountId: string, userId: string) {
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { id: accountId, userId, provider: 'google_drive', status: 'connected' }
  })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })

  // Find root folders (excluding the dedicated 9drive app folder)
  const rootFoldersRes = await drive.files.list({
    q: "'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and name != '9drive'",
    fields: 'files(id, name)',
    pageSize: 100,
  })
  const rootFolders = (rootFoldersRes.data.files ?? []).filter((f): f is { id: string; name: string } => Boolean(f.id && f.name))

  // 1. Immediately create all root folders so they are instantly visible on the website!
  for (const rf of rootFolders) {
    const existing = await prisma.folder.findFirst({
      where: { userId, connectedAccountId: account.id, providerFolderId: rf.id, deletedAt: null }
    })
    if (!existing) {
      await prisma.folder.create({
        data: {
          userId,
          name: rf.name,
          provider: 'google_drive',
          providerFolderId: rf.id,
          connectedAccountId: account.id,
          color: account.color || '#3b82f6',
          parentId: null,
        }
      })
    }
  }

  // 2. Find and batch-insert root files
  const rootFilesRes = await drive.files.list({
    q: "'root' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id, name, mimeType, size)',
    pageSize: 200,
  })
  const rootFiles = (rootFilesRes.data.files ?? []).filter((f) => Boolean(f.id && f.name))

  if (rootFiles.length > 0) {
    const fileIds = rootFiles.map((f) => f.id!)
    const existing = await prisma.file.findMany({
      where: { userId, connectedAccountId: account.id, providerFileId: { in: fileIds } },
      select: { id: true, providerFileId: true, status: true },
    })
    const existingMap = new Map(existing.map((e) => [e.providerFileId, e]))

    const toReactivate = existing.filter((e) => e.status !== 'active').map((e) => e.id)
    if (toReactivate.length > 0) {
      await prisma.file.updateMany({
        where: { id: { in: toReactivate } },
        data: { status: 'active', deletedAt: null, folderId: null }
      })
    }

    const newFiles = rootFiles
      .filter((f) => !existingMap.has(f.id!))
      .map((child) => ({
        userId,
        connectedAccountId: account.id,
        folderId: null,
        provider: 'google_drive',
        providerFileId: child.id!,
        name: child.name!,
        mimeType: child.mimeType || 'application/octet-stream',
        sizeBytes: BigInt(child.size ?? 0),
        status: 'active',
      }))

    if (newFiles.length > 0) {
      await prisma.file.createMany({
        data: newFiles,
        skipDuplicates: true,
      })
    }
  }

  // 3. Import child contents for root folders (using depth 3 to avoid infinite loops/photo sinkholes)
  const folderIds = rootFolders.map((f) => f.id)
  const result = await importGoogleDriveItems(accountId, userId, folderIds, [], null, 3)

  // Also sync the dedicated 9drive app folder
  await syncGoogleAppFolderFiles(accountId, userId).catch(() => undefined)

  return result
}
