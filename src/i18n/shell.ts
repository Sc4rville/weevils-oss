import { defineMessages } from './index'

// src/ui/shell.tsx: full-screen page frame.
export default defineMessages({
  fr: {
    back: (where: string) => `retour · ${where}`,
  },
  en: {
    back: (where: string) => `back · ${where}`,
  },
})
