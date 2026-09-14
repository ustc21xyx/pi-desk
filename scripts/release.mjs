// Maintainer action: build and publish both Mac architectures, never credentials or local Pi data.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as asar from '@electron/asar'

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed; release stopped.`)
  return capture ? result.stdout.trim() : ''
}
function clean() { if (run('git', ['status', '--porcelain'], true)) throw new Error('Commit and push source changes before publishing.') }
try {
  if (process.platform !== 'darwin') throw new Error('Build Mac releases on macOS.')
  clean()
  run('/bin/sh', ['.githooks/pre-push'])
  run('git', ['fetch', 'origin', 'main'])
  const head = run('git', ['rev-parse', 'HEAD'], true)
  if (head !== run('git', ['rev-parse', 'origin/main'], true)) throw new Error('Only the pushed main revision can be released.')
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a stable release version.')
  const tag = `v${version}`, repo = 'ustc21xyx/pi-desk'
  const releases = JSON.parse(run('gh', ['api', `repos/${repo}/releases?per_page=100`], true))
  if (releases.some(release => release.tag_name === tag)) throw new Error('Release already exists. Do not overwrite published versions; choose a new version.')
  run('npm', ['run', 'build'])
  run('npm', ['run', 'icons'])
  run('node_modules/.bin/electron-builder', ['--mac', 'dmg', '--arm64', '--x64', '--publish', 'never'])
  const digests = new Map()
  for (const arch of ['arm64', 'x64']) {
    const bundle = join('release', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Pi Desk.app')
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    run('/usr/bin/lipo', ['-verify_arch', arch === 'arm64' ? 'arm64' : 'x86_64', join(bundle, 'Contents/MacOS/Pi Desk')])
    const resources = join(bundle, 'Contents/Resources'), archive = join(resources, 'app.asar')
    if (asar.listPackage(archive).some(p => !/^\/(out|node_modules)(\/|$)/.test(p) && p !== '/package.json')) throw new Error('Unexpected packaged files.')
    function verify(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) verify(path)
        else if (!readFileSync(path).equals(asar.extractFile(archive, path))) throw new Error('Packaged build differs from source output.')
      }
    }
    verify('out')
    for (const helper of ['desk-bridge.mjs', 'naming-provider.mjs', 'update-install.sh']) {
      if (!readFileSync(join('resources', helper)).equals(readFileSync(join(resources, helper)))) throw new Error('Packaged helper mismatch.')
    }
    if (JSON.parse(asar.extractFile(archive, 'package.json')).version !== version) throw new Error('Packaged version mismatch.')
    const filename = `Pi-Desk-${version}-${arch}.dmg`
    run('/usr/bin/hdiutil', ['verify', join('release', filename)])
    digests.set(filename, createHash('sha256').update(readFileSync(join('release', filename))).digest('hex'))
  }
  clean()
  const checksums = `release/SHA256SUMS-${version}.txt`
  writeFileSync(checksums, [...digests].map(([name, digest]) => `${digest}  ${name}`).join('\n') + '\n')
  const changelog = readFileSync('CHANGELOG.md', 'utf8')
  const notes = changelog.split(`# ${version}\n`)[1]?.split(/\n# /)[0]?.trim()
  if (!notes) throw new Error('Add release notes to CHANGELOG.md first.')
  const notesPath = `release/notes-${version}.md`
  writeFileSync(notesPath, `${notes}\n\nApple Silicon：arm64；Intel：x64。首次安装将 Pi Desk 拖入应用程序文件夹。\n`)
  run('gh', ['release', 'create', tag, ...[...digests.keys()].map(name => join('release', name)), checksums, '--repo', repo, '--draft', '--target', head, '--title', `Pi Desk ${version}`, '--notes-file', notesPath])
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'databaseId'], true))
  const assets = JSON.parse(run('gh', ['api', `repos/${repo}/releases/${release.databaseId}/assets`], true))
  for (const [name, digest] of digests) {
    if (assets.find(asset => asset.name === name)?.digest !== `sha256:${digest}`) throw new Error('GitHub digest mismatch. Release remains a draft; do not publish.')
  }
  run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  console.log(`Published https://github.com/${repo}/releases/tag/${tag}`)
} catch (error) { console.error(error.message); process.exitCode = 1 }
