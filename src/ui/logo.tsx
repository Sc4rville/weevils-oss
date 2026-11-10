import type { CSSProperties } from 'react'

/**
 * Le logo de weevboss : un carré plein, un petit rectangle incliné posé sur son coin, une tige qui retombe.
 * Un seul aplat, couleur pilotée par currentColor. Tracé d'après le dessin d'origine.
 */
export const WEEVBOSS_PATH =
  'M261 443H619L686 316L829 386L808 428C985 525 1036 650 1036 853H977C977 665 912 557 771 503L747 551L701 527V887H261Z'

export function WeevbossLogo({ className, style, title }: { className?: string; style?: CSSProperties; title?: string }) {
  return (
    <svg className={className} style={style} viewBox="261 316 775 571" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <path fill="currentColor" d={WEEVBOSS_PATH} />
    </svg>
  )
}
