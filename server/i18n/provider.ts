import { defineMessages } from '../i18n.ts'
export default defineMessages({
 fr: { waiting: "Les agents sont temporairement indisponibles. Le travail attend leur retour.", unavailable: (tool: string) => `${tool} n’est pas installé ou connecté sur cette machine` },
 en: { waiting: "The agents are temporarily unavailable. Work is waiting for them to return.", unavailable: (tool: string) => `${tool} is not installed or connected on this machine` },
})
