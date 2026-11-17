import type { ReactNode } from 'react'

/**
 * Le jeu d'icônes de weevils : une grille 24 × 24, un seul trait (2,5), des bouts et des angles droits
 * (linecap square, linejoin miter), une seule taille (.ic). Aucun arrondi, aucun caractère Unicode.
 * Les directions (flèche, chevron) sont un seul tracé, tourné.
 */

export type Dir = 'up' | 'right' | 'down' | 'left'
const TURN: Record<Dir, number> = { up: 0, right: 90, down: 180, left: 270 }

/** La boucle de « cycle » et sa pointe, à part : AutoMark les anime séparément. */
const CYCLE_LOOP = 'M4 14v6h16V4H4v6'
const CYCLE_HEAD = 'M1 7l3 3 3-3'

const PATHS = {
  // Tracés de base, orientés vers le haut quand ils ont un sens.
  arrow: 'M12 20V5M5 12l7-7 7 7',
  chevron: 'M5 15l7-7 7 7',
  check: 'M4 12.5l5 5L20 6.5',
  plus: 'M12 4v16M4 12h16',
  minus: 'M4 12h16',
  close: 'M5 5l14 14M19 5L5 19',
  star: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9',
  idle: 'M5 19h14',
  bang: 'M12 4v10M12 18.5v1.5',
  // A session waits for the user: a question mark at right angles, gentler than « ! » (kept for errors).
  waits: 'M7 8V4h10v7h-5v4M12 19v1.5',
  slash: 'M16 3L8 21',
  quote: 'M8.5 5v6M15.5 5v6',
  // Bulle de parole : un rectangle, sa pointe en bas à gauche.
  bubble: 'M3 4h18v12H11l-5 4v-4H3z',
  machine: 'M3 4h18v12H3zM8 20h8',
  more: 'M5 12h1M11.5 12h1M18 12h1',
  mic: 'M9 3h6v10H9zM5 10v6h14v-6M12 16v5M8 21h8',
  enter: 'M19 5v8H6M10 9l-4 4 4 4',
  compact: 'M12 3v11M6 9l6 6 6-6M4 20h16',
  /** Save to the device (camera roll, downloads). */
  save: 'M12 3v11M6 9l6 6 6-6M4 20h16',
  theme: 'M4 4h16v16H4zM12 4v16',
  // Subscriptions: three rising levels, open and light next to the old heavy « % ».
  usage: 'M5 20v-4M12 20v-9M19 20V5',
  // Language: a capital A.
  language: 'M5 21l7-17 7 17M8 14h8',
  logout: 'M10 4H4v16h6M15 8l4 4-4 4M19 12H9',
  agents: 'M4 6h16M4 12h16M4 18h16',
  terminal: 'M4 7l5 5-5 5M12 18h8',
  hash: 'M9 3L7 21M17 3l-2 18M4 9h17M3 15h17',
  reload: 'M20 13v7H4V4h12M13 1l3 3-3 3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4l12 8-12 8z',
  grip: 'M7 9h10M7 15h10',
  file: 'M6 3h8l4 4v14H6z',
  copy: 'M9 9h11v11H9zM15 5V4H4v11h1',
  // Ce qui revient tout seul : la touche « répéter », à angles droits — une boucle ouverte à gauche, sa pointe en bas.
  cycle: `${CYCLE_LOOP}${CYCLE_HEAD}`,
  // Sleep mode: three « z », staggered up to the right, the last one smaller.
  sleep: 'M2 14h7l-7 7h7M11 7h7l-7 7h7M18 2h4l-4 4h4',
} as const

export type IconName = keyof typeof PATHS

/** Icônes pleines (aplat, angles vifs) : pixel art sur la même grille 24. */
const FILLED = {
  // Diablotin : un carré, deux cornes, deux yeux évidés.
  devil: 'M4 9h16v12H4zM4 3h4v6H4zM16 3h4v6h-4zM8 13v3h3v-3zM13 13v3h3v-3z',
  // Fantôme : un dôme en marches, trois pans en bas, deux yeux évidés (un agent qui travaille pendant ton sommeil).
  ghost: 'M8 2h8v2h2v2h2v16h-3v-2h-2v2h-2v-2h-2v2h-2v-2H7v2H4V6h2V4h2zM8 9v4h3V9zM13 9v4h3V9z',
} as const
export type FilledName = keyof typeof FILLED

export function FilledIcon({ name, label, className = '' }: { name: FilledName; label?: string; className?: string }) {
  return (
    <svg className={`ic ${className}`} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" shapeRendering="crispEdges" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <path d={FILLED[name]} />
    </svg>
  )
}

/**
 * Icônes qui peuvent recevoir un contour fin (l'étoile verte « travaille », sur fond clair) : le même tracé, plus large, dessous.
 * Un tracé fait d'un seul trait n'a pas de remplissage, donc paint-order ne suffit pas : le contour est ce trait dessous.
 */
const HALO = new Set<IconName>(['star'])

export function Icon({ name, dir = 'up', label, className = '' }: { name: IconName; dir?: Dir; label?: string; className?: string }) {
  const turn = TURN[dir]
  const transform = turn ? `rotate(${turn} 12 12)` : undefined
  return (
    <svg className={`ic ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="square" strokeLinejoin="miter" strokeMiterlimit={10} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      {HALO.has(name) && <path className="ic-halo" d={PATHS[name]} transform={transform} />}
      <path d={PATHS[name]} transform={transform} />
    </svg>
  )
}

/**
 * Le signe de ce qui tourne tout seul (une automatisation au travail) : la boucle « cycle », en magenta (--auto-fluo),
 * où un segment plein fait le tour comme un tapis roulant ; la boucle entière reste lisible (piste à mi-teinte, contour
 * d'encre en thème clair), la pointe soudée à son bout ouvert. Ni rotation (l'étoile verte), ni clignotement (.fluo) : c'est sa
 * forme et son mouvement qui le distinguent. Animé même en « réduire les animations », comme l'étoile : seul signe de vie.
 */
export function AutoMark({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <svg className={`ic auto-mark ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="square" strokeLinejoin="miter" strokeMiterlimit={10} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <path className="halo" d={`${CYCLE_LOOP}${CYCLE_HEAD}`} />
      <path className="track" d={CYCLE_LOOP} />
      <path className="run" d={CYCLE_LOOP} pathLength={100} />
      <path d={CYCLE_HEAD} />
    </svg>
  )
}

/** Les anciens caractères-icônes, traduits en icônes du jeu. */
const GLYPHS: Record<string, [IconName, Dir?]> = {
  '→': ['arrow', 'right'],
  '←': ['arrow', 'left'],
  '↑': ['arrow', 'up'],
  '↓': ['arrow', 'down'],
  '+': ['plus'],
  '−': ['minus'],
  '✓': ['check'],
  '×': ['close'],
  '*': ['star'],
  '_': ['idle'],
  '!': ['bang'],
  '?': ['waits'],
  '/': ['slash'],
  '"': ['quote'],
  '@': ['machine'],
  '~': ['theme'],
  '%': ['usage'],
  A: ['language'],
  x: ['logout'],
  '&': ['agents'],
  '>': ['chevron', 'right'],
  '<': ['chevron', 'left'],
  '⇣': ['compact'],
  '⏎': ['enter'],
  '#': ['hash'],
  '||': ['pause'],
  '·': ['file'],
  '↻': ['cycle'],
}

/** Une icône à la place d'un caractère ; tout le reste passe tel quel (texte, nœuds React). */
export function G({ c }: { c: ReactNode }) {
  if (typeof c !== 'string') return <>{c}</>
  const g = GLYPHS[c]
  return g ? <Icon name={g[0]} dir={g[1]} /> : <>{c}</>
}
