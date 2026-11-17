import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { attachmentFile } from './attachments.ts'
it('allows inbox photos while refusing missing files, non-images and symlink escapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-photos-'))
  try {
    const inbox = path.join(dir, 'inbox'); fs.mkdirSync(inbox)
    const photo = path.join(inbox, 'photo.jpg'); fs.writeFileSync(photo, 'photo')
    const outside = path.join(dir, 'outside.jpg'); fs.writeFileSync(outside, 'private')
    fs.symlinkSync(outside, path.join(inbox, 'escape.jpg'))
    fs.writeFileSync(path.join(inbox, 'private.txt'), 'private')
    expect(attachmentFile(photo, [inbox])).toEqual({ file: photo, type: 'image/jpeg' })
    for (const file of [outside, path.join(inbox, '../outside.jpg'), path.join(inbox, 'escape.jpg'), path.join(inbox, 'private.txt'), path.join(inbox, 'missing.jpg')]) {
      expect(attachmentFile(file, [inbox])).toBeNull()
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
