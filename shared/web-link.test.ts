import { expect, it } from 'vitest'
import { publicWebUrl, webLinks } from './web-link.ts'
it('links public URLs without trailing punctuation or markdown delimiters', () => {
  const text='Open [the café](https://example.com/cafe?view=wide). Then https://example.com/rooms_(north)!'
  expect(webLinks(text).map(x=>x.url)).toEqual(['https://example.com/cafe?view=wide','https://example.com/rooms_(north)'])
})
it.each(['javascript:alert(1)','data:text/html,test','file:///tmp/a','http://localhost:4179','http://127.1','http://2130706433','http://10.1.2.3','http://172.19.1.1','http://192.168.1.1','https://service.local','https://u:secret@example.com','https://example.com/?token=secret','https://example.com/#k=secret','https://example.com/api/site/capability/repo/','https://example.com/\npath'])('does not expose unsafe or private destination %s', url=>{
 expect(publicWebUrl(url)).toBeUndefined()
})
