import { useEffect } from 'react'
import { LANGS, LANG_NAMES, langIsChosen, setLang, syncServer, useLang, useT } from '../i18n'
import M from '../i18n/prefs'
import { Line } from './bits'
import { TourLine } from './tour'
import { TipsLine } from './tips'

/** App-wide preferences shown in the bottom band: language, intro, tips (devil mode: the devil next to the logo). */
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
      <TourLine />
      <TipsLine />
    </>
  )
}
