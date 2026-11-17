#!/usr/bin/env node
// Détecteur de chaînes en dur (i18n). Node pur, sans dépendance.
//
//   node scripts/check-i18n.mjs [--report] [--unflagged] [files...]
//
// Sans fichier : src/**/*.{ts,tsx} et shared/**/*.ts (hors catalogues et tests), server/**/*.{ts,sh,md}
// (hors server/i18n et tests), server/wv, server/weevils-cli, index.html, public/manifest.webmanifest,
// public/sw.js. Affiche « fichier:ligne: extrait » par trouvaille, puis le compte par fichier.
// Code de sortie 1 s'il reste une trouvaille (--report : toujours 0).
//
// Heuristiques :
//   jsx-text   texte JSX contenant une lettre
//   attr       valeur littérale d'un attribut affiché (aria-label, title, placeholder, alt, label, meta…)
//   jsx-expr   chaîne littérale dans une expression enfant JSX ({ok ? 'oui' : 'non'}), hors comparaisons
//   prop       chaîne littérale d'une propriété affichée ({ label: '…', title: '…', error: '…' })
//   call       argument d'un appel affiché (new Error('…'), plural(n, '…', '…'), alert('…')…)
// Jamais signalé : imports, console.*(…) et log(…), regex, commentaires ; comparaisons et clés id/kind/type sauf accents.
//   fr         chaîne (ou texte echo/printf, ligne markdown) avec des caractères ou des mots français
// --unflagged liste en plus les chaînes non signalées, pour régler les heuristiques.
// Une ligne est ignorée si elle (ou la ligne précédente) contient un commentaire « i18n-ignore ».
// Les catalogues (src/i18n, server/i18n, shared/i18n.ts) et les fichiers *.fr.* ne sont pas lus :
// c'est là que vivent les textes français.

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const abs = (rel) => (path.isAbsolute(rel) ? rel : path.join(ROOT, rel))

// ---------------------------------------------------------------------------------------------
// Vocabulaire

const FR_CHARS = /[àâçéèêëîïôûùüÿœæÀÂÇÉÈÊËÎÏÔÛÙÜŸŒÆ«»’]/
// Mots français absents de l'anglais courant et du code (une chaîne de plusieurs mots en contenant un est du français).
const FR_WORDS = new Set(
  `le la les des une du aux au ce cet cette ces qui que quoi dont où ou et est sont sera était pas plus moins
  sur sous dans avec sans pour par chez vers entre aussi encore déjà tout toute tous toutes rien aucun aucune chaque
  mais donc car ne je tu il elle nous vous ils elles mon ma mes ton ta tes son sa ses notre votre leur leurs lui
  ici là voici oui non merci bonjour salut fais faire fait lance lancer ouvre ouvrir ouverte ferme fermer lire lit
  envoie envoyer cherche chercher replier déplier modifie annuler valider choisir choisie choisi réglage réglages
  nouvelle nouveau nouvelles nouveaux projet projets travaille disponible attente parle parler dicte erreur
  introuvable connexion connecté hors ligne autre autres premier première dernier dernière jour jours heure heures
  depuis avant après quand comme alors très peu trop bien mal moi toi soi être avoir peut peux veux doit
  rien personne aucune voix touche dossier fichier clé absente absent manquant vide inconnue inconnu refusé refusée
  invalide demande travaillent ouvert ouvertes lue lues fini finie finies prochaine prochain choix faible
  moyen élevé fichiers tabulation divers regarde consulte planifie délègue écoute arrête reprendre reprend garder garde`
    .split(/\s+/)
    .filter((w) => w && !w.endsWith('?')),
)
// Mots français seuls trop ambigus en anglais : comptent seulement à côté d'un autre mot.
const FR_SOLO_OK = new Set(
  `replier déplier travaille disponible introuvable annuler valider envoyer lancer ouvrir fermer réglages
  nouvelle nouveau modifie planifie délègue consulte cherche regarde demande lance lit moyen haut bas oui non merci moi jour jours choix fichier fichiers divers travaillent ouverte ouvertes
  tabulation`.split(/\s+/),
)
// Marques et noms techniques identiques dans toutes les langues.
const BRAND = /\b(weevils?d?|weevboss|wv|claude( code)?|codex|github|gitHub|vps|tmux|zellij|opus|sonnet|haiku|fable|cartesia|openai|anthropic|siri|ok|pwa|https?|url|api|id|json|ssh|cli)\b/gi

const ATTRS = new Set([
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
  'title', 'placeholder', 'alt', 'label', 'meta', 'hint', 'text', 'message', 'confirm', 'empty', 'tip', 'caption',
  'subtitle', 'heading', 'desc', 'description', 'note', 'ask', 'question', 'cta', 'action', 'help',
])
const PROPS = new Set([
  'label', 'title', 'placeholder', 'hint', 'text', 'desc', 'description', 'message', 'msg', 'error', 'empty',
  'help', 'tip', 'caption', 'subtitle', 'heading', 'summary', 'detail', 'reason', 'attention', 'note', 'body',
  'ask', 'question', 'confirm', 'cta', 'say', 'aria-label', 'ariaLabel', 'short_name', 'name_fr',
])
const CALLS = new Set([
  'Error', 'TypeError', 'RangeError', 'alert', 'confirm', 'prompt', 'toast', 'notify', 'say', 'speak',
  'plural', 'setError', 'setErr', 'setMsg', 'setMessage', 'setNote', 'setHint', 'setStatus', 'setInfo', 'flash', 'showNotification',
])

const hasLetter = (s) => /\p{L}/u.test(s)
const words = (s) => s.toLowerCase().split(/[^\p{L}'’-]+/u).filter(Boolean)

/** Texte « affichable » : il reste des lettres une fois retirés marques, placeholders, entités et codes. */
function prose(s) {
  const t = s
    .replace(/\$\{\}/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(BRAND, ' ')
    .replace(/\b[a-z]{1,2}\b/gi, (w) => (/^(à|a|y|tu|il|on|je|ta|ma|sa|un|le|la|de|du|et|ou|en|ne|se|me|te|ce|is|it|in|on|to|of|no|go|do|be|by|or|an|at|my|me|we|us|up|so|if)$/i.test(w) ? w : ' '))
  return hasLetter(t)
}
/** Ressemble à un identifiant, une classe CSS, un chemin, une clé, une URL… plutôt qu'à du texte. */
function codeish(s) {
  if (/^[\w$.:/@#%+-]*$/.test(s) && !/^[a-zà-ÿ]+$/i.test(s)) return true // foo-bar, a.b, /api/x, #fff
  if (/^[a-z][\w-]*( [a-z][\w-]*)*$/.test(s) && /[-_]/.test(s)) return true // classes CSS : "row live"
  if (/^(https?:|\/|\.\/|~\/|[a-z]+:\/\/)/.test(s)) return true
  return false
}
function french(s) {
  if (FR_CHARS.test(s)) return true
  const w = words(s)
  if (w.length >= 2 && w.some((x) => FR_WORDS.has(x))) return true
  if (w.length === 1 && FR_SOLO_OK.has(w[0])) return true
  return false
}

// ---------------------------------------------------------------------------------------------
// Lexeur TS/TSX : chaînes, gabarits, regex, commentaires, JSX. Émet des jetons avec leur contexte.

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '==', '===', '!=', '!==', 'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', '+=', '-=', '?.', '...'])
const JSX_PREV = new Set(['(', ',', '=', ':', '[', '!', '?', '{', '}', ';', '=>', '&&', '||', '??', 'return', 'JSXEND', null])

function lexTs(src, jsx) {
  const out = []
  const stack = [{ t: 'code', kind: 'top', depth: 0 }]
  // Parenthèses ouvertes (tous cadres confondus) : sait si une chaîne est dans console.log(…).
  const parens = []
  let i = 0
  const n = src.length
  // Jetons significatifs récents (pour le contexte d'une chaîne).
  let hist = []
  const pushTok = (tok) => {
    hist.push(tok)
    if (hist.length > 6) hist = hist.slice(-6)
  }
  const prev = () => (hist.length ? hist[hist.length - 1] : null)
  const top = () => stack[stack.length - 1]
  const jsxCtx = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k]
      if (f.t === 'code' && (f.kind === 'jsxchild' || f.kind === 'jsxattr')) return f
      if (f.t === 'code' && f.kind === 'top') return null
    }
    return null
  }
  const emitStr = (value, start, extra = {}) => {
    const h = hist.slice()
    const p1 = h[h.length - 1] ?? null
    const p2 = h[h.length - 2] ?? null
    const p3 = h[h.length - 3] ?? null
    let key = null
    if (p1 === ':' && p2 && /^[\w$-]+$/.test(p2.replace(/^['"]|['"]$/g, '')) && (p3 === '{' || p3 === ',' || p3 === null)) key = p2.replace(/^['"]|['"]$/g, '')
    // Appel dont la chaîne est un argument direct : f('…') ou f(x, '…').
    const inner = parens[parens.length - 1]
    const callee = (p1 === '(' || p1 === ',') && inner?.callee ? inner.callee : null
    const ctx = jsxCtx()
    const log = parens.some((p) => p.log)
    out.push({ type: 'str', value, start, key, callee, log, prev: p1, jsx: ctx ? ctx.kind : null, attr: ctx?.name ?? null, ...extra })
  }
  const nextSig = (k) => {
    while (k < n && /\s/.test(src[k])) k++
    return src.slice(k, k + 3)
  }

  while (i < n) {
    const f = top()
    if (f.t === 'code') {
      const c = src[i]
      if (/\s/.test(c)) { i++; continue }
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
      if (c === "'" || c === '"') {
        let j = i + 1, v = ''
        while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { v += src[j + 1]; j += 2 } else v += src[j++] }
        const after = nextSig(j + 1)
        emitStr(v, i, { cmpNext: /^(===|!==|==|!=)/.test(after), quote: c })
        pushTok(c + v + c)
        i = j + 1
        continue
      }
      if (c === '`') {
        const h = hist.slice()
        stack.push({ t: 'tpl', start: i, parts: [''], hist: h })
        i++
        continue
      }
      if (c === '/' && REGEX_PREV.has(prev()) || (c === '/' && prev() === null)) {
        let j = i + 1, cls = false
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue }
          if (src[j] === '[') cls = true
          else if (src[j] === ']') cls = false
          else if (src[j] === '/' && !cls) break
          j++
        }
        j++
        while (j < n && /[a-z]/.test(src[j])) j++
        pushTok('REGEX')
        i = j
        continue
      }
      if (jsx && c === '<' && JSX_PREV.has(prev()) && /[A-Za-z>]/.test(src[i + 1] ?? '')) {
        stack.push({ t: 'jsxtag', start: i })
        i++
        continue
      }
      if (c === '{') { f.depth++; parens.push({}); pushTok('{'); i++; continue }
      if (c === '}') {
        if (f.depth === 0 && f.kind !== 'top') {
          stack.pop()
          const p = top()
          if (p.t === 'tpl') { p.parts.push(''); hist = p.hist; }
          i++
          continue
        }
        f.depth--
        parens.pop()
        pushTok('}')
        i++
        continue
      }
      if (c === '(') {
        const h = hist
        const p = h[h.length - 1]
        // console.*(…), ou un raccourci local log(…) (journal pour les développeurs).
        const log = (h[h.length - 2] === '.' && h[h.length - 3] === 'console') || (p === 'log' && h[h.length - 2] !== '.')
        parens.push({ log, callee: p && /^[A-Za-z_$][\w$]*$/.test(p) && !['if', 'while', 'for', 'switch', 'return', 'typeof', 'catch'].includes(p) ? p : null })
      } else if (c === '[') parens.push({})
      else if (c === ')' || c === ']') parens.pop()
      const m = /^(?:[A-Za-z_$][\w$]*|\d[\w.]*|=>|===|!==|==|!=|&&|\|\||\?\?|\?\.|\.\.\.|\+=|-=|[^\s])/.exec(src.slice(i, i + 64))
      pushTok(m[0])
      i += m[0].length
      continue
    }
    if (f.t === 'tpl') {
      const c = src[i]
      if (c === '\\') { f.parts[f.parts.length - 1] += src[i + 1] ?? ''; i += 2; continue }
      if (c === '`') {
        stack.pop()
        hist = f.hist
        const value = f.parts.join('${}')
        emitStr(value, f.start, { tpl: true, cmpNext: /^(===|!==|==|!=)/.test(nextSig(i + 1)) })
        pushTok('TPL')
        i++
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        f.hist = hist.slice()
        stack.push({ t: 'code', kind: 'tplexpr', depth: 0 })
        hist = ['(']
        i += 2
        continue
      }
      f.parts[f.parts.length - 1] += c
      i++
      continue
    }
    if (f.t === 'jsxtag') {
      const c = src[i]
      if (/\s/.test(c)) { i++; continue }
      if (f.name === undefined) {
        if (c === '/') {
          // Balise fermante : on referme l'élément parent.
          const e = src.indexOf('>', i)
          i = e < 0 ? n : e + 1
          stack.pop() // jsxtag
          if (top().t === 'jsxchildren') stack.pop()
          afterJsx()
          continue
        }
        const m = /^[\w.:-]*/.exec(src.slice(i))
        f.name = m[0]
        i += m[0].length
        continue
      }
      if (c === '/' && src[i + 1] === '>') { stack.pop(); i += 2; afterJsx(); continue }
      if (c === '>') { stack.pop(); stack.push({ t: 'jsxchildren', name: f.name }); i++; continue }
      if (c === '{') { stack.push({ t: 'code', kind: 'jsxspread', depth: 0 }); hist = ['{']; i++; continue }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue }
      const m = /^[\w:.-]+/.exec(src.slice(i))
      if (!m) { i++; continue }
      const name = m[0]
      i += name.length
      let j = i
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] !== '=') continue
      j++
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j]
        const e = src.indexOf(q, j + 1)
        out.push({ type: 'attr', name, value: src.slice(j + 1, e), start: j })
        i = e + 1
      } else if (src[j] === '{') {
        stack.push({ t: 'code', kind: 'jsxattr', name, depth: 0 })
        hist = ['{']
        i = j + 1
      } else i = j
      continue
    }
    if (f.t === 'jsxchildren') {
      let j = i
      while (j < n && src[j] !== '{' && src[j] !== '<') j++
      if (j > i) out.push({ type: 'jsxtext', value: src.slice(i, j), start: i })
      i = j
      if (i >= n) break
      if (src[i] === '{') { stack.push({ t: 'code', kind: 'jsxchild', depth: 0 }); hist = ['{']; i++; continue }
      stack.push({ t: 'jsxtag', start: i })
      i++
      continue
    }
  }
  if (stack.length !== 1) process.stderr.write(`check-i18n: lexer lost track (${stack.map((f) => f.t + (f.kind ? ':' + f.kind : '')).join(' > ')})\n`)
  return out

  function afterJsx() {
    if (top().t === 'code') pushTok('JSXEND')
  }
}

// ---------------------------------------------------------------------------------------------
// Analyse par type de fichier

function lineOf(src) {
  const starts = [0]
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1)
  return (pos) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1 }
    return lo + 1
  }
}

function checkTs(file, src) {
  const jsx = file.endsWith('.tsx')
  const toks = lexTs(src, jsx)
  const at = lineOf(src)
  const res = []
  const add = (pos, rule, text) => res.push({ line: at(pos), rule, text })
  for (const t of toks) {
    if (t.type === 'jsxtext') {
      const v = t.value.trim()
      if (hasLetter(v) && prose(v)) {
        // Position de la première lettre, pour pointer la bonne ligne.
        const k = t.value.search(/\S/)
        add(t.start + Math.max(0, k), 'jsx-text', v)
      }
      continue
    }
    if (t.type === 'attr') {
      if (ATTRS.has(t.name) && hasLetter(t.value) && prose(t.value) && !codeish(t.value)) add(t.start, 'attr', `${t.name}="${t.value}"`)
      else if (french(t.value)) add(t.start, 'fr', t.value)
      continue
    }
    // Chaîne littérale.
    const v = t.value
    if (!hasLetter(v) || t.log) continue
    if (t.prev === 'import' || t.prev === 'from' || t.callee === 'require' || t.callee === 'import') continue
    // Comparaison ou identifiant : seuls les accents comptent (comparer à un texte affiché est à revoir).
    const cmp = t.cmpNext || ['===', '!==', '==', '!=', 'case'].includes(t.prev)
    if (cmp || (t.key && /(^id|Id|_id|^kind|^type)$/.test(t.key))) { if (FR_CHARS.test(v)) add(t.start, 'fr', v); continue }
    if (french(v)) { add(t.start, 'fr', v); continue }
    if (!prose(v) || codeish(v)) continue
    if (t.jsx === 'jsxattr' && ATTRS.has(t.attr) && t.prev !== '[' && !t.key) { add(t.start, 'attr', `${t.attr}=${v}`); continue }
    if (t.jsx === 'jsxchild' && !t.key && !t.callee && t.prev !== '[') { add(t.start, 'jsx-expr', v); continue }
    if (t.key && PROPS.has(t.key) && /\s|^\p{Ll}+$/u.test(v)) { add(t.start, 'prop', `${t.key}: ${v}`); continue }
    if (t.callee && CALLS.has(t.callee) && (/\s/.test(v) || !/Error$/.test(t.callee))) { add(t.start, 'call', `${t.callee}(${v})`); continue }
    if (UNFLAGGED && /\p{L}{2}/u.test(v)) UNFLAGGED.push(`${file}:${at(t.start)}: ${t.key ? t.key + ': ' : ''}${t.callee ? t.callee + '(' : ''}${v}`)
  }
  return res
}

/** Shell : commentaires # retirés (hors guillemets) ; texte français dans les chaînes ou derrière echo/printf. */
function checkSh(file, src) {
  const res = []
  src.split('\n').forEach((raw, k) => {
    if (k === 0 && raw.startsWith('#!')) return
    let code = '', q = null
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j]
      if (q) { code += c; if (c === q && raw[j - 1] !== '\\') q = null; continue }
      if (c === "'" || c === '"') { q = c; code += c; continue }
      if (c === '#' && (j === 0 || /[\s;]/.test(raw[j - 1]))) break
      code += c
    }
    const quoted = [...code.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2])
    const echo = /\b(?:echo|printf)\s+(.*)$/.exec(code)
    const pieces = [...quoted, ...(echo ? [echo[1]] : [])]
    const hit = pieces.find((p) => french(p))
    if (hit !== undefined) res.push({ line: k + 1, rule: 'fr', text: code.trim() })
  })
  return res
}

/** Markdown (gabarit de prompt) : toute ligne française compte. */
function checkMd(file, src) {
  const res = []
  src.split('\n').forEach((raw, k) => {
    if (/^\s*```/.test(raw)) return
    if (raw.includes('<!--') && raw.includes('-->') && !raw.replace(/<!--.*?-->/g, '').trim()) return
    if (french(raw)) res.push({ line: k + 1, rule: 'fr', text: raw.trim() })
  })
  return res
}

/** HTML : texte et attributs affichés ; tout ce qui est français. */
function checkHtml(file, src) {
  const res = []
  const at = lineOf(src)
  const body = src.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length)).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '))
  for (const m of body.matchAll(/>([^<]+)</g)) {
    const v = m[1].trim()
    if (hasLetter(v) && prose(v)) res.push({ line: at(m.index + 1 + m[1].search(/\S/)), rule: 'html-text', text: v })
  }
  for (const m of body.matchAll(/\s(aria-label|title|alt|placeholder|content)="([^"]*)"/g)) {
    const v = m[2]
    const tag = body.slice(body.lastIndexOf('<', m.index), m.index)
    if (m[1] === 'content' && !/name="(description|apple-mobile-web-app-title|application-name)"/.test(tag + body.slice(m.index, body.indexOf('>', m.index)))) continue
    if (hasLetter(v) && prose(v)) res.push({ line: at(m.index), rule: 'attr', text: `${m[1]}="${v}"` })
  }
  for (const m of body.matchAll(/"([^"\n]*)"/g)) if (french(m[1])) res.push({ line: at(m.index), rule: 'fr', text: m[1] })
  return res
}

/** JSON (manifeste) : champs affichés, et tout ce qui est français. */
function checkJson(file, src) {
  const res = []
  const at = lineOf(src)
  for (const m of src.matchAll(/"([\w-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const [, key, v] = m
    if (french(v) || (['name', 'short_name', 'description'].includes(key) && prose(v))) res.push({ line: at(m.index), rule: french(v) ? 'fr' : 'prop', text: `${key}: ${v}` })
  }
  return res
}

// ---------------------------------------------------------------------------------------------
// Fichiers

const EXCLUDED = (rel) =>
  /(^|\/)(node_modules|dist)\//.test(rel) ||
  /^src\/i18n\//.test(rel) ||
  /^server\/i18n\//.test(rel) ||
  rel === 'shared/i18n.ts' ||
  /\.(test|spec)\.[jt]sx?$/.test(rel) ||
  /\.fr\.[^/]+$/.test(rel)

function walk(dir, exts) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  const out = []
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(rel, exts)) }
    else if (exts.some((x) => e.name.endsWith(x))) out.push(rel)
  }
  return out
}

function defaults() {
  const files = [
    ...walk('src', ['.ts', '.tsx']),
    ...walk('shared', ['.ts']),
    ...walk('server', ['.ts', '.sh', '.md']),
    'server/wv',
    'server/weevils-cli',
    'index.html',
    'public/manifest.webmanifest',
    'public/sw.js',
  ]
  return [...new Set(files)].filter((f) => !EXCLUDED(f) && fs.existsSync(path.join(ROOT, f))).sort()
}

function kindOf(rel, src) {
  if (/\.tsx?$/.test(rel) || /\.m?js$/.test(rel)) return 'ts'
  if (/\.sh$/.test(rel) || /^#!.*\b(ba)?sh\b/.test(src)) return 'sh'
  if (/\.md$/.test(rel)) return 'md'
  if (/\.html?$/.test(rel)) return 'html'
  if (/\.(json|webmanifest)$/.test(rel)) return 'json'
  return null
}

function check(rel) {
  const src = fs.readFileSync(abs(rel), 'utf8')
  const kind = kindOf(rel, src)
  const fn = { ts: checkTs, sh: checkSh, md: checkMd, html: checkHtml, json: checkJson }[kind]
  if (!fn) return []
  const lines = src.split('\n')
  const ignored = (l) => /i18n-ignore/.test(lines[l - 1] ?? '') || /i18n-ignore/.test(lines[l - 2] ?? '')
  const seen = new Set()
  return fn(rel, src)
    .filter((f) => !ignored(f.line))
    .filter((f) => { const k = `${f.line}\0${f.text}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.line - b.line)
}

// ---------------------------------------------------------------------------------------------

const args = process.argv.slice(2)
// --unflagged : liste les chaînes littérales non signalées (pour régler les heuristiques).
var UNFLAGGED = args.includes('--unflagged') ? [] : null
const report = args.includes('--report')
const named = args.filter((a) => !a.startsWith('--'))
const files = named.length
  ? named.map((f) => { const r = path.relative(ROOT, path.resolve(f)).split(path.sep).join('/'); return r.startsWith('../') ? path.resolve(f) : r })
  : defaults()

const counts = []
let total = 0
for (const rel of files) {
  const found = check(rel)
  if (!found.length) continue
  for (const f of found) {
    const snip = f.text.replace(/\s+/g, ' ')
    console.log(`${rel}:${f.line}: [${f.rule}] ${snip.length > 110 ? snip.slice(0, 107) + '…' : snip}`)
  }
  counts.push([rel, found.length])
  total += found.length
}

if (total) {
  console.log('')
  const w = Math.max(...counts.map(([f]) => f.length))
  for (const [f, c] of counts.sort((a, b) => b[1] - a[1])) console.log(`${f.padEnd(w)}  ${String(c).padStart(4)}`)
  console.log(`${'total'.padEnd(w)}  ${String(total).padStart(4)}  (${counts.length} files)`)
} else console.log('i18n: no hardcoded strings')

if (UNFLAGGED) console.log(['', '-- unflagged --', ...UNFLAGGED].join('\n'))
process.exit(total && !report ? 1 : 0)
