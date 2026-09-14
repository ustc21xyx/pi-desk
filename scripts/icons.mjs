import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { Resvg } from '@resvg/resvg-js'
const svg = await readFile(new URL('../build/icon.svg', import.meta.url), 'utf8')
const root = new URL('../build/', import.meta.url)
const iconset = new URL('icon.iconset/', root)
await mkdir(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size * scale } }).render().asPng()
    await writeFile(new URL(`icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`, iconset), png)
  }
}
execFileSync('/usr/bin/iconutil', ['-c', 'icns', new URL('icon.iconset', root).pathname, '-o', new URL('icon.icns', root).pathname])
