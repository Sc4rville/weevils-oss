import type { ForYouItem } from './foryou.ts'

/** Retired per-commit announcements, including older posts with an ordinary post/digest id. */
export function rawEngineeringNotice(id: string, text = ''): boolean {
  return /^(?:commit|deploy):/.test(id)
    || /(?:\ba un nouveau commit\b|\bhas a new commit\b|\bweevils (?:version|build) [a-f\d]{7,40}\b)/i.test(text)
    || /^\s*(?:[a-f\d]{7,40}\s+)?(?:fix|feat|chore|refactor|test|docs|build|ci|perf|style)(?:\([^\n)]*\))?!?:\s/i.test(text)
}

/** Keep the human result in the feed; technical evidence stays in the session itself. */
export function humanFeedText(text: string): string {
  const urls: string[] = []
  text = text.replace(/https?:\/\/[^\s<>"']+/g, (url) => `§LINK${urls.push(url) - 1}§`)
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(?:[a-f\d]{7,40}\s+)?(?:fix|feat|chore|refactor|test|docs|build|ci|perf|style)(?:\([^\n)]*\))?!?:[^\n]*$/gmi, '')
    .replace(/^\s*(?:diff --git|@@|\+\+\+ |--- |\$ |git (?:log|show|status|diff|commit)\b|at \S+\([^)]*:\d+)[^\n]*$/gm, '')
    .replace(/\([^()\n]*(?:\bcommit\b|\b[a-f\d]{7,40}\b)[^()\n]*\)/gi, '')
    .replace(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b/gi, '')
    .replace(/\b(?=[a-f\d]{7,40}\b)(?=[a-f\d]*[a-f])[a-f\d]{7,40}\b/gi, '')
    .replace(/(?<![\w:/])(?:(?:~|\.{1,2})\/(?:[\w.@~+-]+\/)*[\w.@~+-]+|\/(?:[\w.@~+-]+\/)+[\w.@~+-]+)/g, '')
    .replace(/\b(?:[\w.@+-]+\/)+[\w.@+-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|sh|py|log|lock)\b/g, '')
    .replace(/\b(?!Node\.js\b)[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|sh|py|log|lock)\b/g, '')
    .replace(/`\s*`/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([,.;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/§LINK(\d+)§/g, (_, n: string) => urls[Number(n)] ?? '')
}

export function humanFeedItem(item: ForYouItem): ForYouItem {
  return { ...item, text: humanFeedText(item.text),
    ...(item.title ? { title: humanFeedText(item.title) } : {}),
    ...(item.body ? { body: humanFeedText(item.body) } : {}),
    ...(item.moreText ? { moreText: humanFeedText(item.moreText) } : {}),
  }
}
