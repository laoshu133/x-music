import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { ensureTrack, upsertTrackFileStatus } from '@/lib/cache/store'
import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'
import { createJob } from '@/lib/jobs'
import { triggerInlineTagging } from '@/lib/tagging/inline'
import { createTaggingProvider, taggingInternals } from '@/lib/tagging/provider'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'
import type { MusicInfo } from '@/lib/types'
import type { IAudioMetadata } from 'music-metadata'

const payload: TagTrackFileJobPayload = {
  trackFileId: 1,
  rawPath: '/tmp/x-music-inbox/raw.flac',
  source: 'tx',
  songmid: '0039MnYb0qxYhV',
  quality: 'flac',
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  albumId: '000MkMni19ClKG',
}

test('tagging score follows music-tag-web title artist album matching threshold', () => {
  const score = taggingInternals.scoreMetadataMatch(
    { title: '晴天', artist: '周杰伦', album: '叶惠美' },
    { name: '晴天', artist: '周杰伦', album: '叶惠美', albumId: '000MkMni19ClKG' },
  )
  assert.equal(score, 6)

  const wrongArtistScore = taggingInternals.scoreMetadataMatch(
    { title: '晴天', artist: '孙燕姿', album: '叶惠美' },
    { name: '晴天', artist: '周杰伦', album: '叶惠美' },
  )
  assert.equal(wrongArtistScore, 2)
})

test('tagging path segments are sanitized and organized by artist and album', () => {
  const finalPath = taggingInternals.buildFinalPath(payload, {
    title: '晴天?',
    artist: '周杰伦/杰伦',
    album: '叶惠美:2003',
  })

  assert.equal(path.basename(finalPath), '周杰伦 杰伦 - 晴天.flac')
  assert.equal(finalPath.includes(path.join('周杰伦 杰伦', '叶惠美 2003')), true)
})

test('tagging sidecars use Emby-compatible album cover and track lyrics paths', () => {
  const finalPath = taggingInternals.buildFinalPath(payload, {
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
  })
  const sidecars = taggingInternals.buildSidecarPaths(finalPath, {
    lyrics: '[00:00.00]晴天',
    cover: { data: Buffer.from('cover'), mime: 'image/jpeg' },
  })

  assert.equal(path.basename(sidecars.lyricsPath ?? ''), '周杰伦 - 晴天.lrc')
  assert.equal(path.basename(sidecars.coverPath ?? ''), 'cover.jpg')
  assert.equal(path.dirname(sidecars.coverPath ?? ''), path.dirname(finalPath))
})

test('payload metadata wins over existing file metadata', () => {
  const existingMetadata = {
    format: { tagTypes: [] },
    native: {},
    quality: { warnings: [] },
    common: {
      track: { no: null, of: null },
      disk: { no: null, of: null },
      title: 'Old Title',
      artist: 'Old Artist',
      album: 'Old Album',
      year: 1999,
    },
  } as unknown as IAudioMetadata

  const metadata = taggingInternals.mergePayloadMetadata(payload, existingMetadata)

  assert.equal(metadata.title, '晴天')
  assert.equal(metadata.artist, '周杰伦')
  assert.equal(metadata.album, '叶惠美')
  assert.equal(metadata.albumId, '000MkMni19ClKG')
  assert.equal(metadata.year, '1999')
})

test('builtin tagging rewrites flac tags without parsing stale picture blocks', async () => {
  await fs.mkdir(appConfig.inboxDir, { recursive: true })
  const rawPath = path.join(appConfig.inboxDir, `stale-picture-${Date.now()}.flac`)
  await fs.writeFile(rawPath, buildMinimalFlacWithMalformedPictureBlock())

  const result = await createTaggingProvider().tagFile({
    ...payload,
    rawPath,
    trackFileId: Date.now(),
    songmid: `offline-flac-${Date.now()}`,
    title: '云南里',
    artist: '方大同',
    album: '云南里',
    albumId: '000li4Ry1X5mDj',
  })

  const output = await fs.readFile(result.finalPath)
  assert.equal(output.subarray(0, 4).toString('ascii'), 'fLaC')
  assert.match(output.toString('utf8'), /TITLE=云南里/)
  assert.match(output.toString('utf8'), /ARTIST=方大同/)
})

test('inline tagging drains queued builtin tag jobs', async () => {
  await fs.mkdir(appConfig.inboxDir, { recursive: true })
  const rawPath = path.join(appConfig.inboxDir, `raw-${Date.now()}.txt`)
  await fs.writeFile(rawPath, 'fake audio')

  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid: `TAG_${Date.now()}`,
    name: 'Inline Tag Test',
    singer: 'Tester',
    albumName: 'Inline Album',
  }
  const track = ensureTrack(musicInfo)
  const trackFile = upsertTrackFileStatus(track.id, '128k', 'tagging', { rawPath, finalPath: rawPath })
  const job = createJob({
    type: 'tag_track_file',
    payload: {
      trackFileId: trackFile.id,
      rawPath,
      source: 'tx',
      songmid: musicInfo.songmid,
      quality: '128k',
      title: musicInfo.name,
      artist: musicInfo.singer,
      album: musicInfo.albumName,
    },
  })

  triggerInlineTagging()
  await waitFor(() => {
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined
    return row?.status === 'completed'
  })

  const row = db.prepare('SELECT status, final_path, raw_path, tagged_at FROM track_files WHERE id = ?').get(trackFile.id) as
    | { status: string; final_path: string; raw_path: string | null; tagged_at: string | null }
    | undefined
  assert.equal(row?.status, 'ready')
  assert.ok(row?.final_path.includes(path.join('Tester', 'Inline Album')))
  assert.ok(row?.tagged_at)
  assert.equal(row?.raw_path, null)
  await assert.rejects(fs.access(rawPath), { code: 'ENOENT' })
  await fs.access(row!.final_path)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('condition not met before timeout')
}

function buildMinimalFlacWithMalformedPictureBlock(): Buffer {
  const streamInfo = Buffer.alloc(34)
  const vorbisComment = buildVorbisComment(['TITLE=Old Title'])
  const malformedPicture = Buffer.alloc(128)
  malformedPicture.writeUInt32BE(3, 0)
  malformedPicture.writeUInt32BE(340, 4)
  malformedPicture.write('image/jpeg', 8, 'ascii')
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    flacBlock(0, streamInfo),
    flacBlock(4, vorbisComment),
    flacBlock(6, malformedPicture),
    flacBlock(1, Buffer.alloc(0), true),
    Buffer.from([0xff, 0xf8, 0, 0]),
  ])
}

function buildVorbisComment(comments: string[]): Buffer {
  const vendor = Buffer.from('test', 'utf8')
  const parts = [uint32LE(vendor.length), vendor, uint32LE(comments.length)]
  for (const comment of comments) {
    const encoded = Buffer.from(comment, 'utf8')
    parts.push(uint32LE(encoded.length), encoded)
  }
  return Buffer.concat(parts)
}

function flacBlock(type: number, data: Buffer, isLast = false): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt8(type | (isLast ? 0x80 : 0), 0)
  header.writeUIntBE(data.length, 1, 3)
  return Buffer.concat([header, data])
}

function uint32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}
