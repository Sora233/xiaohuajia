import fs from 'node:fs'
import path from 'node:path'

const src = path.resolve('dist-single/index.html')
if (!fs.existsSync(src)) {
  console.error('missing', src)
  process.exit(1)
}
const html = fs.readFileSync(src, 'utf8')
const targets = [
  path.resolve('luanbi.html'),
  path.resolve('dist-single/luanbi.html'),
  '/opt/cursor/artifacts/luanbi.html',
]
for (const dest of targets) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, html)
  const kb = (fs.statSync(dest).size / 1024).toFixed(1)
  console.log(`wrote ${dest} (${kb} KB)`)
}
