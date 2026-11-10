import { useEffect } from 'react'
import { LANGS, LANG_NAMES, langIsChosen, setLang, syncServer, useLang, useT } from '../i18n'
import M from '../i18n/prefs'
import D from '../i18n/devil'
import { useApp } from './app-context'
import { Line } from './bits'
import { setDevil, useDevil } from './devil'
import { FilledIcon } from './icons'
import { OnboardingLine } from './onboarding'
import { TipsLine } from './tips'

/** App-wide preferences shown in the bottom band: language, intro, tips, devil mode. */
export function PrefLines() {
  const t = useT(M)
  const lang = useLang()
  // weevilsd follows a language explicitly chosen here (agents, voice, notifications). An app that merely follows its
  // browser never pushes it: any browser in another language (a test, a borrowed phone) would switch the server for everyone.
  useEffect(() => {
    if (langIsChosen()) syncServer()
  }, [])
  const next = LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length]
  return (
    <>
      <Line ch="~" go={null} meta={langIsChosen() ? t.chosen : t.followsBrowser} onClick={() => setLang(next)}>
        {t.language} · {LANG_NAMES[lang]}
      </Line>
      <OnboardingLine />
      <TipsLine />
      <DevilLine />
    </>
  )
}

/** Devil mode: only when the server has a model plugged in (DEVIL_API_URL). */
function DevilLine() {
  const t = useT(D)
  const { snap } = useApp()
  const enabled = !!snap.devil?.enabled
  const on = useDevil(enabled)
  if (!enabled) return null
  return (
    <Line ch={<FilledIcon name="devil" />} go={null} meta={t.lineMeta} onClick={() => setDevil(!on)}>
      {on ? t.on : t.off}
    </Line>
  )
}

