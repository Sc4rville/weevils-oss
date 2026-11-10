// Génère les icônes PNG (bandes de couleur, sans dépendance) dans public/.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const bands = ['#B39BFF', '#6FA4FF', '#FF7F67', '#FF8AD6', '#FFC64C'].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)))

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    const [r, g, b] = bands[Math.min(bands.length - 1, Math.floor((y / size) * bands.length))]
    const row = y * (size * 3 + 1)
    for (let x = 0; x < size; x++) raw.set([r, g, b], row + 1 + x * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const s of [180, 192, 512]) writeFileSync(`public/icon-${s}.png`, png(s))
console.log('icônes générées')
