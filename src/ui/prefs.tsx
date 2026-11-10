import { useEffect, useId, useRef, useState } from 'react'
import { LANGS, LANG_NAMES, browserLang, langIsChosen, setLang, useLang, useT, type Lang } from '../i18n'
import M from '../i18n/prefs'
import { Line } from './bits'
import { TourLine } from './tour'
import { TipsLine } from './tips'
import { Icon } from './icons'
import './prefs.css'

/** App-wide preferences shown in the bottom band: language, intro, tips (devil mode: the devil next to the logo). */
export function PrefLines() {
  const t = useT(M)
  const lang = useLang()
  const [picking, setPicking] = useState(false)
  const chosen = langIsChosen()
  // Never switched by a single tap (a stray tap in the bottom band once left the whole app in English): the line opens
  // the choices, and only a tap on one of them changes the language.
  const pick = (l: Lang | null) => {
    setPicking(false)
    if (l === null ? chosen : !chosen || l !== lang) setLang(l)
  }
  return (
    <>
      <Line ch="~" go={null} meta={chosen ? t.chosen : t.followsBrowser} onClick={() => setPicking((p) => !p)}>
        {t.language} · {LANG_NAMES[lang]}
      </Line>
      {picking && (
        <div className="lang-pick" role="group" aria-label={t.language}>
          <Line ch={chosen ? '' : '✓'} go={null} onClick={() => pick(null)}>
            {t.followBrowser(LANG_NAMES[browserLang()])}
          </Line>
          {LANGS.map((l: Lang) => (
            <Line key={l} ch={chosen && l === lang ? '✓' : ''} go={null} onClick={() => pick(l)}>
              <span lang={l}>{LANG_NAMES[l]}</span>
            </Line>
          ))}
        </div>
      )}
      <TourLine />
      <TipsLine />
    </>
  )
}

/** Always discoverable in the existing bottom rail, with no overlay on the composer. */
export function LanguageButton({ compact = false }: { compact?: boolean }) {
  const t = useT(M)
  const lang = useLang()
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const chosen = langIsChosen()
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    dialog.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
  }, [open])
  const pick = (value: Lang | null) => { setLang(value); dialog.current?.close() }
  return <>
    <button type="button" className="language-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-controls={id} aria-expanded={open} aria-label={`${t.language} · ${LANG_NAMES[lang]}`}>{compact ? lang.toUpperCase() : LANG_NAMES[lang]}</button>
    <dialog ref={dialog} id={id} className="language-dialog band" aria-labelledby={`${id}-title`} onClose={() => setOpen(false)} onClick={(e) => {
      if (e.target !== e.currentTarget) return
      const box = e.currentTarget.getBoundingClientRect()
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) e.currentTarget.close()
    }}>
      <div className="language-dialog-head"><h2 id={`${id}-title`}>{t.language}</h2><button type="button" className="ch" aria-label={t.closeLanguage} onClick={() => dialog.current?.close()}><Icon name="close" /></button></div>
      <div className="language-options" role="group" aria-label={t.language}>
        <button type="button" aria-pressed={!chosen} onClick={() => pick(null)}>{t.followBrowser(LANG_NAMES[browserLang()])}</button>
        {LANGS.map((value) => <button key={value} type="button" aria-pressed={chosen && value === lang} onClick={() => pick(value)}><span lang={value}>{LANG_NAMES[value]}</span></button>)}
      </div>
    </dialog>
  </>
}
