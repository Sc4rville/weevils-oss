// Replies read like a chat app: the blocks an agent writes are recognised, emphasis never reaches into code or links.
import { describe, expect, it } from 'vitest'
import { blocks, spans } from './md'

describe('blocks', () => {
  it('headings, a bold line as heading, paragraphs, lists after a paragraph line, quote, rule', () => {
    const b = blocks('## Done\nThe fix is live.\nWhat changed:\n- one **thing**\n  - a detail\n- two\n\n**Next steps:**\n1. ship\n2. tell Scarville\n\n> send this\n> to them\n\n---\nend')
    expect(b.map((x) => x.kind)).toEqual(['heading', 'para', 'list', 'heading', 'list', 'quote', 'rule', 'para'])
    expect(b[2]).toMatchObject({ ordered: false, items: [{ text: 'one **thing**', sub: ['a detail'] }, { text: 'two', sub: [] }] })
    expect(b[3]).toMatchObject({ level: 3, text: 'Next steps' })
    expect(b[4]).toMatchObject({ ordered: true, start: 1 })
    expect(b[5]).toMatchObject({ text: 'send this\nto them' })
  })
  it('a table and a fenced code block keep their content', () => {
    const b = blocks('| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |\n\n```sh\nnpm test\n# not a heading\n```')
    expect(b[0]).toEqual({ kind: 'table', head: ['a', 'b'], rows: [['1', '2'], ['3']] })
    expect(b[1]).toEqual({ kind: 'code', lang: 'sh', body: 'npm test\n# not a heading' })
  })
  it('an unclosed fence takes the rest; plain text stays one paragraph with its line breaks', () => {
    expect(blocks('one\ntwo')).toEqual([{ kind: 'para', text: 'one\ntwo' }])
    expect(blocks('```\nx')).toEqual([{ kind: 'code', lang: '', body: 'x' }])
  })
})

describe('spans', () => {
  it('bold and italic, not inside code, snake_case or a link target', () => {
    expect(spans('a **b** *c* _d_')).toEqual([{ kind: 'text', s: 'a ' }, { kind: 'strong', s: 'b' }, { kind: 'text', s: ' ' }, { kind: 'em', s: 'c' }, { kind: 'text', s: ' ' }, { kind: 'em', s: 'd' }])
    expect(spans('`a **b**` my_var_name 2*3*4')).toEqual([{ kind: 'text', s: '`a **b**` my_var_name 2*3*4' }])
    expect(spans('[x](https://a.io/_b_)')).toEqual([{ kind: 'text', s: '[x](https://a.io/_b_)' }])
  })
})
