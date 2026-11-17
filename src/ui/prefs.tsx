import { useEffect, useId, useRef, useState } from 'react'
import { LANGS, LANG_NAMES, installLang, langIsChosen, setLang, useLang, useT, type Lang } from '../i18n'
import M from '../i18n/prefs'
import { Line } from './bits'
import { Icon } from './icons'
import './prefs.css'

/** Settings row: « language   English ». A tap opens the choices; only a tap on one of them changes the language
 *  (a stray tap once left the whole app in English), on this device only. */
export function LanguageLine() {
  const t = useT(M)
  const lang = useLang()
  const [picking, setPicking] = useState(false)
  const chosen = langIsChosen()
  const pick = (l: Lang | null) => {
    setPicking(false)
    if (l === null ? chosen : !chosen || l !== lang) setLang(l)
  }
  return (
    <>
      <Line ch="A" go={null} value={LANG_NAMES[lang]} onClick={() => setPicking((p) => !p)}>
        {t.language}
      </Line>
      {picking && (
        <div className="lang-pick" role="group" aria-label={t.language}>
          <Line ch={chosen ? '' : '✓'} go={null} onClick={() => pick(null)}>
            {t.followDefault(LANG_NAMES[installLang()])}
          </Line>
          {LANGS.map((l: Lang) => (
            <Line key={l} ch={chosen && l === lang ? '✓' : ''} go={null} onClick={() => pick(l)}>
              <span lang={l}>{LANG_NAMES[l]}</span>
            </Line>
          ))}
        </div>
      )}
    </>
  )
}

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
        <button type="button" aria-pressed={!chosen} onClick={() => pick(null)}>{t.followDefault(LANG_NAMES[installLang()])}</button>
        {LANGS.map((value) => <button key={value} type="button" aria-pressed={chosen && value === lang} onClick={() => pick(value)}><span lang={value}>{LANG_NAMES[value]}</span></button>)}
      </div>
    </dialog>
  </>
}
