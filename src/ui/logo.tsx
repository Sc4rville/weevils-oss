import { useId, type CSSProperties } from 'react'
const cutout = '/branding/weevboss-cutout.png'

/** One PNG, one shared edge/flat-colour cleanup, then a CSS-only theme filter. */
export function WeevbossLogo({ className, style, title, recording = false }: { className?: string; style?: CSSProperties; title?: string; recording?: boolean }) {
  const filter = useId()
  return <svg className={`weevboss-logo ${className ?? ''}`} style={style} viewBox="106 126 1046 1046" width={44} height={44} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
    <defs>
      <filter id={filter} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer result="planes">
          <feFuncR type="discrete" tableValues={recording ? "0.9 0.95 1 1 1" : "0.1294 0.2863 0.6235 0.6235 0.6235"} />
          <feFuncG type="discrete" tableValues={recording ? "0.9 0.95 1 1 1" : "0.1059 0.2510 0.4784 0.4784 0.4784"} />
          <feFuncB type="discrete" tableValues={recording ? "0.9 0.95 1 1 1" : "0.1804 0.3725 0.9176 0.9176 0.9176"} />
          <feFuncA type="linear" slope="1.111111" intercept="-0.111111" />
        </feComponentTransfer>
        {recording && <>
          <feFlood floodColor="currentColor" result="recordingColour" />
          <feComposite in="planes" in2="recordingColour" operator="arithmetic" k1={1} k2={0} k3={0} k4={0} />
        </>}
      </filter>
    </defs>
    <image href={cutout} width={1254} height={1254} filter={`url(#${filter})`} />
  </svg>
}
