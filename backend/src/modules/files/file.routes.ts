import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { getAuthedGoogleClient, syncGoogleAppFolderFiles, syncGoogleQuota } from '../google/google.service.js'
import { deleteS3Object, syncS3Quota, createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { streamProviderFile } from './stream-file.js'
import { googleDownloadExportMimeTypes, normalizeHeaders, withExtension } from './stream-google-file.js'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { createAuditLog } from '../../utils/audit.js'
import { ZipArchive } from 'archiver'
import { transferFile } from './file-transfer.service.js'
import { importAllFromGoogleDrive } from '../google/google-import.service.js'



export const fileRouter = Router()

fileRouter.get('/preview/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token)
    const preview = await prisma.filePreviewToken.findFirst({
      where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
      include: { file: { include: { connectedAccount: true } } },
    })
    if (!preview || preview.file.status !== 'active') return res.status(404).json({ code: 'PREVIEW_NOT_FOUND', message: 'Preview token not found.' })
    return streamProviderFile(preview.file, req.headers.range, res, { disposition: 'inline' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.use(requireAuth)

fileRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({
      folderId: z.string().nullable().optional(),
      all: z.string().optional(),
      q: z.string().trim().max(255).optional(),
      kind: z.enum(['image', 'video', 'pdf', 'doc', 'archive', 'audio']).optional(),
      accountId: z.string().optional(),
      accountIds: z.string().optional(),
      minSize: z.coerce.number().optional(),
      maxSize: z.coerce.number().optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional()
    }).parse(req.query)

    const typeFilters: Record<string, string[]> = {
      image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
      video: ['video/mp4', 'video/mpeg', 'video/ogg', 'video/quicktime', 'video/webm'],
      pdf: ['application/pdf'],
      doc: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
      archive: ['application/zip', 'application/x-rar-compressed', 'application/x-tar', 'application/x-7z-compressed'],
      audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/mp4']
    }

    const accountIds = query.accountIds
      ? query.accountIds.split(',').map((s) => s.trim()).filter(Boolean)
      : query.accountId
      ? [query.accountId]
      : undefined

    const isSearch = Boolean(
      query.q ||
      query.kind ||
      query.minSize !== undefined ||
      query.maxSize !== undefined ||
      query.startDate ||
      query.endDate
    )

    let folderFilter: { folderId?: string | null } = {}
    if (query.all === '1') {
      folderFilter = {}
    } else if (query.folderId !== undefined) {
      if (query.folderId === 'root' || query.folderId === 'null' || !query.folderId) {
        folderFilter = { folderId: null }
      } else {
        folderFilter = { folderId: query.folderId }
      }
    } else if (isSearch) {
      folderFilter = {}
    } else {
      folderFilter = { folderId: null }
    }

    const where: any = {
      userId: req.user!.id,
      status: 'active',
      ...folderFilter,
      ...(query.q ? { name: { contains: query.q } } : {}),
      ...(accountIds && accountIds.length > 0 ? { connectedAccountId: { in: accountIds } } : {}),
      ...(query.kind ? { mimeType: { in: typeFilters[query.kind] || [] } } : {}),
      ...(query.minSize !== undefined || query.maxSize !== undefined ? {
        sizeBytes: {
          ...(query.minSize !== undefined ? { gte: BigInt(query.minSize) } : {}),
          ...(query.maxSize !== undefined ? { lte: BigInt(query.maxSize) } : {})
        }
      } : {}),
      ...(query.startDate || query.endDate ? {
        createdAt: {
          ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
          ...(query.endDate ? { lte: new Date(query.endDate) } : {})
        }
      } : {})
    }

    const files = await prisma.file.findMany({
      where,
      include: {
        connectedAccount: { select: { id: true, email: true, provider: true, color: true } },
        folder: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    return res.json({ files: files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() })) })
  } catch (error) {
    return next(error)
  }
})

const batchFileSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1).max(100),
  permanent: z.boolean().optional(),
})

fileRouter.patch('/batch', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.extend({ folderId: z.string().nullable().optional() }).parse(req.body)
    if (body.folderId) await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user!.id, deletedAt: null } })
    const result = await prisma.file.updateMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' }, data: { folderId: body.folderId ?? null } })
    await createAuditLog(req.user!.id, 'MOVE_FILES', 'file', undefined, { count: result.count, folderId: body.folderId })
    return res.json({ status: 'ok', moved: result.count })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/batch', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const files = await prisma.file.findMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' },
      include: { connectedAccount: true }
    })

    const syncedAccountIds = new Set<string>()

    if (body.permanent) {
      const deletedIds: string[] = []
      for (const file of files) {
        try {
          if (file.provider === 's3') {
            await deleteS3Object(file)
          } else if (file.providerFileId && file.connectedAccount) {
            const auth = await getAuthedGoogleClient(file.connectedAccount)
            const drive = google.drive({ version: 'v3', auth })
            await drive.files.delete({ fileId: file.providerFileId })
          }
          deletedIds.push(file.id)
          syncedAccountIds.add(file.connectedAccountId)
          await createAuditLog(req.user!.id, 'PERMANENT_DELETE_FILE', 'file', file.id, { name: file.name })
        } catch (error: any) {
          const is404 = error?.status === 404 || error?.code === 404 || error?.response?.status === 404
          if (is404) {
            deletedIds.push(file.id)
            syncedAccountIds.add(file.connectedAccountId)
            await createAuditLog(req.user!.id, 'PERMANENT_DELETE_FILE', 'file', file.id, { name: file.name })
          } else {
            console.error(`Failed to permanently delete file ${file.id} from Google Drive:`, error)
          }
        }
      }
      if (deletedIds.length > 0) {
        await prisma.file.deleteMany({
          where: { id: { in: deletedIds }, userId: req.user!.id }
        })
      }
    } else {
      // Move to Google Drive Trash (Bin) and mark deleted in DB
      for (const file of files) {
        try {
          if (file.providerFileId && file.connectedAccount) {
            const auth = await getAuthedGoogleClient(file.connectedAccount)
            const drive = google.drive({ version: 'v3', auth })
            await drive.files.update({
              fileId: file.providerFileId,
              requestBody: { trashed: true }
            })
            syncedAccountIds.add(file.connectedAccountId)
          }
          await createAuditLog(req.user!.id, 'TRASH_FILE', 'file', file.id, { name: file.name })
        } catch (error) {
          console.error(`Failed to trash file ${file.id} on Google Drive:`, error)
        }
      }
      await prisma.file.updateMany({
        where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' },
        data: { status: 'deleted', deletedAt: new Date() }
      })
    }

    for (const accountId of syncedAccountIds) {
      const account = files.find((f) => f.connectedAccountId === accountId)?.connectedAccount
      if (account?.provider === 's3') {
        await syncS3Quota(accountId).catch(() => undefined)
      } else {
        await syncGoogleQuota(accountId).catch(() => undefined)
      }
    }

    return res.json({ status: 'ok', deleted: files.length })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/trash', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ q: z.string().trim().max(255).optional() }).parse(req.query)
    const files = await prisma.file.findMany({
      where: {
        userId: req.user!.id,
        status: 'deleted',
        ...(query.q ? { name: { contains: query.q } } : {})
      },
      include: {
        connectedAccount: { select: { id: true, email: true, provider: true } },
        folder: { select: { id: true, name: true } }
      },
      orderBy: { deletedAt: 'desc' }
    })
    return res.json({ files: files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() })) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/batch/restore', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const files = await prisma.file.findMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'deleted' },
      include: { connectedAccount: true }
    })
    const syncedAccountIds = new Set<string>()

    for (const file of files) {
      try {
        if (file.providerFileId && file.connectedAccount && file.connectedAccount.provider !== 's3') {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.update({
            fileId: file.providerFileId,
            requestBody: { trashed: false }
          })
          syncedAccountIds.add(file.connectedAccountId)
        }
      } catch (error) {
        console.error(`Failed to untrash file ${file.id} on Google Drive:`, error)
      }
    }

    const result = await prisma.file.updateMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'deleted' },
      data: { status: 'active', deletedAt: null }
    })
    for (const f of files) {
      await createAuditLog(req.user!.id, 'RESTORE_FILE', 'file', f.id, { name: f.name })
    }

    for (const accountId of syncedAccountIds) {
      await syncGoogleQuota(accountId).catch(() => undefined)
    }

    return res.json({ status: 'ok', restored: result.count })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/batch/permanent', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const files = await prisma.file.findMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'deleted' },
      include: { connectedAccount: true }
    })
    const deletedIds: string[] = []
    const syncedAccountIds = new Set<string>()
    const failed: Array<{ fileId: string; message: string }> = []

    for (const file of files) {
      try {
        if (file.provider === 's3') {
          await deleteS3Object(file)
        } else {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.delete({ fileId: file.providerFileId })
        }
        deletedIds.push(file.id)
        syncedAccountIds.add(file.connectedAccountId)
        await createAuditLog(req.user!.id, 'PERMANENT_DELETE_FILE', 'file', file.id, { name: file.name })
      } catch (error: any) {
        const is404 = error?.status === 404 || error?.code === 404 || error?.response?.status === 404
        if (is404) {
          deletedIds.push(file.id)
          syncedAccountIds.add(file.connectedAccountId)
          await createAuditLog(req.user!.id, 'PERMANENT_DELETE_FILE', 'file', file.id, { name: file.name })
        } else {
          failed.push({ fileId: file.id, message: error instanceof Error ? error.message : 'Delete failed' })
        }
      }
    }

    if (deletedIds.length > 0) {
      await prisma.file.deleteMany({
        where: { id: { in: deletedIds }, userId: req.user!.id }
      })
    }

    for (const accountId of syncedAccountIds) {
      const account = files.find((file) => file.connectedAccountId === accountId)?.connectedAccount
      if (account?.provider === 's3') {
        await syncS3Quota(accountId).catch(() => undefined)
      } else {
        await syncGoogleQuota(accountId).catch(() => undefined)
      }
    }

    if (deletedIds.length === 0 && failed.length > 0) {
      return res.status(400).json({ code: 'FILES_DELETE_FAILED', message: 'No files were permanently deleted.', deleted: 0, failed })
    }
    return res.json({ status: 'ok', deleted: deletedIds.length, failed })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/shared-links', async (req: AuthRequest, res, next) => {
  try {
    const shares = await prisma.fileShare.findMany({
      where: { userId: req.user!.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      include: { file: { include: { connectedAccount: { select: { email: true, provider: true } }, folder: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({
      shares: shares.filter((share) => share.file.status === 'active').map((share) => {
        const url = share.token ? `${env.FRONTEND_URL}/public/files/${share.token}` : null
        return {
          id: share.id,
          url,
          createdAt: share.createdAt.toISOString(),
          expiresAt: share.expiresAt?.toISOString() ?? null,
          file: { ...share.file, sizeBytes: share.file.sizeBytes.toString() },
        }
      })
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/sync-google', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      connectedAccountId: z.string().min(1).optional(),
      fullSync: z.boolean().optional().default(true),
    }).parse(req.body ?? {})
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, provider: 'google_drive', status: 'connected', ...(body.connectedAccountId ? { id: body.connectedAccountId } : {}) },
      select: { id: true },
    })

    const results = []
    for (const account of accounts) {
      if (body.fullSync) {
        await importAllFromGoogleDrive(account.id, req.user!.id).catch((err) => {
          console.warn('[sync-google] importAllFromGoogleDrive warning:', err)
        })
      }
      results.push(await syncGoogleAppFolderFiles(account.id, req.user!.id))
    }

    return res.json({
      status: 'ok',
      results,
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } } })
    return res.json({ file: { ...file, sizeBytes: file.sizeBytes.toString() } })
  } catch (error) {
    return next(error)
  }
})

fileRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1).max(255).optional(), folderId: z.string().nullable().optional() }).parse(req.body)
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    const drive = file.provider === 's3' ? null : google.drive({ version: 'v3', auth: await getAuthedGoogleClient(file.connectedAccount) })
    if (body.folderId) await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user!.id, deletedAt: null } })
    if (body.name && drive) await drive.files.update({ fileId: file.providerFileId, requestBody: { name: body.name } })
    const updated = await prisma.file.update({ where: { id: file.id }, data: { ...(body.name ? { name: body.name } : {}), ...(body.folderId !== undefined ? { folderId: body.folderId } : {}) }, include: { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } } })
    await createAuditLog(req.user!.id, 'UPDATE_FILE', 'file', updated.id, { name: updated.name, updates: body })
    return res.json({ file: { ...updated, sizeBytes: updated.sizeBytes.toString() } })
  } catch (error) {
    return next(error)
  }
})

const transferSchema = z.object({ targetAccountId: z.string().min(1) })
const batchTransferSchema = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(100), targetAccountId: z.string().min(1) })

fileRouter.post('/batch-transfer', async (req: AuthRequest, res, next) => {
  try {
    const body = batchTransferSchema.parse(req.body)
    const results: Array<{ fileId: string; success: boolean; error?: string }> = []
    for (const fileId of body.fileIds) {
      try {
        await transferFile(fileId, body.targetAccountId, req.user!.id)
        results.push({ fileId, success: true })
      } catch (err: any) {
        results.push({ fileId, success: false, error: err.message || 'Transfer failed' })
      }
    }
    return res.json({
      transferredCount: results.filter((r) => r.success).length,
      failedCount: results.filter((r) => !r.success).length,
      results,
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/:id/transfer', async (req: AuthRequest, res, next) => {
  try {
    const body = transferSchema.parse(req.body)
    const result = await transferFile(String(req.params.id), body.targetAccountId, req.user!.id)
    return res.json({
      file: {
        ...result.file,
        sizeBytes: result.file.sizeBytes.toString(),
      },
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/:id/share', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id, status: 'active' } })
    const existingShare = await prisma.fileShare.findFirst({ where: { fileId: file.id, userId: req.user!.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' } })

    let shareId = existingShare?.id
    let token = existingShare?.token
    if (!existingShare) {
      token = randomToken(32)
      const share = await prisma.fileShare.create({ data: { fileId: file.id, userId: req.user!.id, token, tokenHash: hashToken(token) } })
      shareId = share.id
    }

    return res.status(existingShare ? 200 : 201).json({ url: `${env.FRONTEND_URL}/public/files/${token}`, shareId })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/:id/public-permission', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    if (file.provider !== 'google_drive') {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'Only Google Drive files can be made public.' })
    }
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    await drive.permissions.create({
      fileId: file.providerFileId,
      requestBody: {
        role: 'writer',
        type: 'anyone'
      }
    })
    const metadata = await drive.files.get({ fileId: file.providerFileId, fields: 'webViewLink,webContentLink' })
    return res.json({ status: 'ok', url: metadata.data.webViewLink ?? metadata.data.webContentLink })
  } catch (error: any) {
    return res.status(500).json({ code: 'GOOGLE_API_ERROR', message: error.message || 'Failed to update Google Drive permissions.' })
  }
})

fileRouter.delete('/:id/share', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    await prisma.fileShare.updateMany({ where: { fileId, userId: req.user!.id, enabled: true }, data: { enabled: false } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/:id/preview-token', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id, status: 'active' } })
    const token = randomToken(32)
    await prisma.filePreviewToken.create({ data: { fileId: file.id, userId: req.user!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 10 * 60_000) } })
    const path = `/files/preview/${token}`
    return res.status(201).json({ path, url: `${req.protocol}://${req.get('host')}${path}` })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id/view-url', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    if (file.provider === 's3') return res.json({ url: null })
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })

    // Automatically set permission to public writer when retrieving/copying the view URL!
    try {
      await drive.permissions.create({
        fileId: file.providerFileId,
        requestBody: {
          role: 'writer',
          type: 'anyone'
        }
      })
    } catch (err: any) {
      console.error('Failed to make Google Drive file public during view-url retrieval:', err.message || err)
    }

    const metadata = await drive.files.get({ fileId: file.providerFileId, fields: 'webViewLink,webContentLink' })
    return res.json({ url: metadata.data.webViewLink ?? metadata.data.webContentLink })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id/download', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    return streamProviderFile(file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const isPermanent = req.query.permanent === 'true' || (req.body && req.body.permanent === true)
    const file = await prisma.file.findFirstOrThrow({
      where: {
        id: fileId,
        userId: req.user!.id,
        ...(isPermanent ? {} : { status: 'active' })
      },
      include: { connectedAccount: true }
    })

    if (isPermanent) {
      try {
        if (file.provider === 's3') {
          await deleteS3Object(file)
        } else if (file.providerFileId && file.connectedAccount) {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.delete({ fileId: file.providerFileId })
        }
      } catch (error: any) {
        const is404 = error?.status === 404 || error?.code === 404 || error?.response?.status === 404
        if (!is404) {
          console.error(`Failed to permanently delete file ${file.id} from provider:`, error)
        }
      }

      await prisma.file.delete({ where: { id: file.id } })
      await createAuditLog(req.user!.id, 'PERMANENT_DELETE_FILE', 'file', file.id, { name: file.name })
    } else {
      try {
        if (file.providerFileId && file.connectedAccount) {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.update({
            fileId: file.providerFileId,
            requestBody: { trashed: true }
          })
        }
      } catch (error) {
        console.error(`Failed to trash file ${file.id} on Google Drive:`, error)
      }

      await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } })
      await createAuditLog(req.user!.id, 'TRASH_FILE', 'file', file.id, { name: file.name })
    }

    if (file.connectedAccountId) {
      if (file.connectedAccount?.provider === 's3') {
        await syncS3Quota(file.connectedAccountId).catch(() => undefined)
      } else {
        await syncGoogleQuota(file.connectedAccountId).catch(() => undefined)
      }
    }

    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/batch-download', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const files = await prisma.file.findMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' },
      include: { connectedAccount: true }
    })
    if (files.length === 0) return res.status(404).json({ code: 'FILES_NOT_FOUND', message: 'No files found.' })

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="9drive-download.zip"')

    const archive = new ZipArchive({ zlib: { level: 9 } })
    archive.on('error', (err: any) => {
      throw err
    })
    archive.pipe(res)

    for (const file of files) {
      try {
        let stream: Readable
        let fileName = file.name
        if (file.provider === 's3') {
          const config = await getS3ConfigForAccount(file.connectedAccountId)
          const client = createS3Client(config)
          const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
          stream = response.Body as Readable
        } else {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          const headers = normalizeHeaders(await auth.getRequestHeaders())
          const exportTarget = googleDownloadExportMimeTypes[file.mimeType]
          if (exportTarget) {
            fileName = withExtension(file.name, exportTarget.extension)
          }
          const url = exportTarget
            ? `https://www.googleapis.com/drive/v3/files/${file.providerFileId}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
            : `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`
          const response = await fetch(url, { headers })
          if (!response.ok || !response.body) continue
          stream = Readable.fromWeb(response.body as any)
        }
        archive.append(stream, { name: fileName })
      } catch (err) {
        console.error(`Failed to add file ${file.name} to zip:`, err)
      }
    }

    await archive.finalize()
  } catch (error) {
    return next(error)
  }
})
