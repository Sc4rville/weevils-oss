/** Presentation only: remove known routing tags from prose lines, never quoted/code content or identifiers. */
export function withoutMachinePrefix(text: string): string {
  let quotation = false
  let fence: { char: string; length: number } | undefined
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.[0] === fence.char && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined
      return line
    }
    if (!line.trim()) quotation = false
    else if (/^ {0,3}>/.test(line)) quotation = true
    // Markdown allows a quoted paragraph to continue without repeating > until a blank line.
    if (quotation) return line
    // Four-space/tab indentation is code; quote markers and inline code never match this prefix.
    const prose = line.replace(/^ {0,3}(?:\[(?:PC|VPS|GPU)\](?:[ \t]+|$))+/i, '')
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(prose)?.[1]
    if (opening) fence = { char: opening[0], length: opening.length }
    return prose
  }).join('\n')
}
