// "For you" media shelf (server/foryou-media.ts): why a file is refused by `weevils show`, and the 404 of the bytes route.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    missing: 'fichier introuvable',
    notFile: 'ce n’est pas un fichier',
    outside: 'fichier hors de tes projets et des dossiers de weevils',
    badType: 'ni une image ni une vidéo (png, jpg, gif, webp, avif, mp4, webm, mov, m4v)',
    badHeader: (ext: string) => `le contenu ne ressemble pas à un .${ext}`,
    tooBig: (mb: number) => `trop lourd : ${mb} Mo max`,
    gone: 'média introuvable',
  },
  en: {
    missing: 'file not found',
    notFile: 'not a file',
    outside: 'file outside your projects and weevils’ folders',
    badType: 'neither an image nor a video (png, jpg, gif, webp, avif, mp4, webm, mov, m4v)',
    badHeader: (ext: string) => `the content does not look like a .${ext}`,
    tooBig: (mb: number) => `too big: ${mb} MB max`,
    gone: 'media not found',
  },
})
