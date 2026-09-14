import { Router } from 'express'
import { z } from 'zod'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { streamProviderFile } from '../files/stream-file.js'
import {
  listPhotos,
  getPhotoDetails,
  getPhotoThumbnailUrl,
  transferPhotos,
  getTargetAccountFolders,
  createTargetAccountFolder,
  createGooglePickerSession,
  pollGooglePickerSession,
  importPickerItems,
  deleteGooglePhotos,
} from './photos.service.js'

export const photosRouter = Router()
photosRouter.use(requireAuth)

// 1. List photos & videos with timeline pagination and filtering
photosRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({
      accountId: z.string().optional(),
      accountIds: z.string().optional(),
      mediaType: z.enum(['all', 'image', 'video']).optional().default('all'),
      search: z.string().trim().max(255).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      page: z.coerce.number().min(1).optional().default(1),
      limit: z.coerce.number().min(1).max(200).optional().default(50),
    }).parse(req.query)

    const accountIds = query.accountIds
      ? query.accountIds.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined

    const result = await listPhotos({
      userId: req.user!.id,
      accountId: query.accountId,
      accountIds,
      mediaType: query.mediaType,
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
      page: query.page,
      limit: query.limit,
    })

    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

// 2. Get target account folders for folder picker modal
photosRouter.get('/target-folders/:accountId', async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.accountId)
    const result = await getTargetAccountFolders(accountId, req.user!.id)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

// 3. Create a new folder on the target account
photosRouter.post('/target-folders', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      accountId: z.string().min(1),
      name: z.string().min(1).max(255),
      parentFolderId: z.string().nullable().optional().default(null),
    }).parse(req.body)

    const folder = await createTargetAccountFolder(
      body.accountId,
      body.name,
      body.parentFolderId,
      req.user!.id
    )
    return res.status(201).json({ folder })
  } catch (error) {
    return next(error)
  }
})

// 4. Batch transfer photos (Copy or Move with MD5 Verification)
const transferSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1).max(500),
  targetAccountId: z.string().min(1),
  targetFolderId: z.string().nullable().optional(),
  mode: z.enum(['copy', 'move']).default('copy'),
  verifyChecksum: z.boolean().optional().default(true),
})

photosRouter.post('/transfer', async (req: AuthRequest, res, next) => {
  try {
    const body = transferSchema.parse(req.body)
    const result = await transferPhotos({
      userId: req.user!.id,
      fileIds: body.fileIds,
      targetAccountId: body.targetAccountId,
      targetFolderId: body.targetFolderId,
      mode: body.mode,
      verifyChecksum: body.verifyChecksum,
    })
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

// 5. Google Photos Picker API - Create Session
photosRouter.post('/picker/session', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ accountId: z.string().min(1) }).parse(req.body)
    const session = await createGooglePickerSession(body.accountId, req.user!.id)
    return res.json(session)
  } catch (error) {
    return next(error)
  }
})

// 6. Google Photos Picker API - Poll Session & Get Selected Media
photosRouter.get('/picker/session/:sessionId', async (req: AuthRequest, res, next) => {
  try {
    const sessionId = String(req.params.sessionId)
    const accountId = z.string().min(1).parse(req.query.accountId)
    const result = await pollGooglePickerSession(accountId, sessionId, req.user!.id)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

// 7. Google Photos Picker API - Import Picked Media to Target Google Drive
const pickerImportSchema = z.object({
  sourceAccountId: z.string().min(1),
  targetAccountId: z.string().min(1),
  targetFolderId: z.string().nullable().optional(),
  items: z.array(z.object({
    id: z.string(),
    baseUrl: z.string().url(),
    name: z.string(),
    mimeType: z.string(),
  })).min(1),
})

photosRouter.post('/picker/import', async (req: AuthRequest, res, next) => {
  try {
    const body = pickerImportSchema.parse(req.body)
    const result = await importPickerItems({
      sourceAccountId: body.sourceAccountId,
      targetAccountId: body.targetAccountId,
      targetFolderId: body.targetFolderId,
      items: body.items,
      userId: req.user!.id,
    })
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

  // 8. Bulk delete Google Photos media items
  const deleteSchema = z.object({
    accountId: z.string().min(1),
    mediaItemIds: z.array(z.string().min(1)).min(1),
  })

  photosRouter.delete('/', async (req: AuthRequest, res, next) => {
    try {
      const body = deleteSchema.parse(req.body)
      const result = await deleteGooglePhotos({
        accountId: body.accountId,
        userId: req.user!.id,
        mediaItemIds: body.mediaItemIds,
      })
      return res.json(result)
    } catch (error) {
      return next(error)
    }
  })

  // 9. Account Google Photos status (checks if Google Photos permissions are granted)
photosRouter.get('/accounts-status', async (req: AuthRequest, res, next) => {
  try {
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, provider: 'google_drive', status: 'connected' },
      select: { id: true, email: true, displayName: true, color: true, scopes: true },
    })

    const statuses = accounts.map((acc) => {
      const scopes = (acc.scopes as string[]) || []
      const hasPhotosScope = scopes.some((s) => s.toLowerCase().includes('photos'))
      return {
        id: acc.id,
        email: acc.email,
        displayName: acc.displayName,
        color: acc.color,
        hasPhotosScope,
      }
    })

    return res.json({ accounts: statuses })
  } catch (error) {
    return next(error)
  }
})

// 9. Batch Download selected photos as ZIP
photosRouter.post('/batch-download', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(100) }).parse(req.body)
    const files = await prisma.file.findMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' },
      include: { connectedAccount: true },
    })

    if (files.length === 0) {
      return res.status(404).json({ code: 'PHOTOS_NOT_FOUND', message: 'No photos found.' })
    }

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="9drive-photos.zip"')

    const archive = (archiver as any)('zip', { zlib: { level: 6 } })
    archive.on('error', (err: any) => {
      throw err
    })
    archive.pipe(res)

    for (const file of files) {
      try {
        const auth = await (await import('../google/google.service.js')).getAuthedGoogleClient(file.connectedAccount)
        const headers = await auth.getRequestHeaders()
        const url = `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`
        const response = await fetch(url, { headers })
        if (!response.ok || !response.body) continue
        const stream = Readable.fromWeb(response.body as any)
        archive.append(stream, { name: file.name })
      } catch (err) {
        console.warn(`Failed to add photo ${file.name} to zip:`, err)
      }
    }

    await archive.finalize()
  } catch (error) {
    return next(error)
  }
})

// 8. Get photo metadata & EXIF details
photosRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const details = await getPhotoDetails(fileId, req.user!.id)
    return res.json(details)
  } catch (error) {
    return next(error)
  }
})

// 9. High-speed thumbnail delivery
photosRouter.get('/:id/thumbnail', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const size = Number(req.query.size ?? 400)
    const thumbnailUrl = await getPhotoThumbnailUrl(fileId, req.user!.id, size)
    if (thumbnailUrl) {
      // Redirect 302 to Google Drive CDN directly for lightning fast edge caching
      return res.redirect(302, thumbnailUrl)
    }

    // Fallback to streaming directly from Google Drive / S3
    const file = await prisma.file.findFirstOrThrow({
      where: { id: fileId, userId: req.user!.id, status: 'active' },
      include: { connectedAccount: true },
    })
    return streamProviderFile(file, undefined, res, { disposition: 'inline' })
  } catch (error) {
    return next(error)
  }
})

// 10. Stream original photo/video bit-for-bit
photosRouter.get('/:id/stream', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({
      where: { id: fileId, userId: req.user!.id, status: 'active' },
      include: { connectedAccount: true },
    })
    return streamProviderFile(file, req.headers.range, res, { disposition: 'inline' })
  } catch (error) {
    return next(error)
  }
})
