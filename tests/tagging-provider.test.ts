import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureTrack, upsertTrackFileStatus } from '@/lib/cache/store'
import { db } from '@/lib/db'
import { createJob } from '@/lib/jobs'
import { triggerInlineTagging } from '@/lib/tagging/inline'
import { taggingInternals } from '@/lib/tagging/provider'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'
import type { MusicInfo } from '@/lib/types'
import type { IAudioMetadata } from 'music-metadata'

const payload: TagTrackFileJobPayload = {
  trackFileId: 1,
  rawPath: '/tmp/mixmusic-inbox/raw.flac',
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

test('inline tagging drains queued builtin tag jobs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mixmusic-tagging-'))
  const rawPath = path.join(tempRoot, 'raw.txt')
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

  const row = db.prepare('SELECT status, final_path FROM track_files WHERE id = ?').get(trackFile.id) as
    | { status: string; final_path: string }
    | undefined
  assert.equal(row?.status, 'ready')
  assert.ok(row?.final_path.includes(path.join('Tester', 'Inline Album')))
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('condition not met before timeout')
}
