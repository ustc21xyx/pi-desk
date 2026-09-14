import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败，更新已停止。`)
  return capture ? result.stdout.trim() : ''
}
function requireClosed() {
  const result = spawnSync('/usr/bin/pgrep', ['-f', '^/Applications/Pi Desk[.]app/Contents/'], { stdio: 'ignore' })
  if (result.status === 0) throw new Error('请先从 Pi Desk 菜单退出应用，再运行更新。正在进行的任务需要先完成或由你结束。')
  if (result.error || result.status !== 1) throw new Error('无法确认应用是否退出，更新已停止。')
}

let lock, lockFd, stage
try {
  if (process.platform !== 'darwin') throw new Error('此更新脚本仅支持 macOS。')
  const gitRoot = run('git', ['rev-parse', '--show-toplevel'], true)
  if (gitRoot !== root) throw new Error('请在 Pi Desk 独立仓库内更新。')
  lock = resolve(run('git', ['rev-parse', '--git-path', 'pi-desk-update.lock'], true))
  try { lockFd = openSync(lock, 'wx', 0o600) } catch { throw new Error(`已有更新任务或上次更新异常中止。确认没有更新任务后，删除 ${lock} 再重试。`) }
  if (run('git', ['status', '--porcelain'], true)) throw new Error('仓库存在未提交的改动，请先提交或自行保存后再更新。')
  requireClosed()
  console.log('正在拉取代码…')
  run('git', ['pull', '--ff-only'])
  console.log('正在安装依赖并构建…')
  run('npm', ['ci'])
  run('npm', ['run', 'pack:mac'])
  const source = join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Pi Desk.app')
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source])
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(source, 'Contents/Info.plist')], true)
  const target = '/Applications/Pi Desk.app'
  const stagePath = `/Applications/.Pi Desk-update-${process.pid}.app`
  if (existsSync(stagePath)) throw new Error('暂存目录已存在，更新已停止。')
  stage = stagePath
  run('/usr/bin/ditto', [source, stage])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stage])
  requireClosed()
  const backupDir = join(root, 'release', 'installed-backup')
  mkdirSync(backupDir, { recursive: true })
  const backup = join(backupDir, `Pi Desk-before-update-${Date.now()}-${process.pid}.app`)
  const previous = `/Applications/.Pi Desk-previous-${process.pid}.app`
  if (existsSync(previous)) throw new Error('旧版暂存目录已存在，更新已停止。')
  const hadApp = existsSync(target)
  if (hadApp) {
    run('/usr/bin/ditto', [target, backup])
    requireClosed()
    renameSync(target, previous)
  }
  try { renameSync(stage, target); stage = undefined } catch (error) {
    if (hadApp) renameSync(previous, target)
    throw error
  }
  if (hadApp) rmSync(previous, { recursive: true })
  console.log(`已安装 Pi Desk ${version}。${hadApp ? `旧版保存在 ${backup}` : ''}`)
  run('/usr/bin/open', ['-a', target])
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (stage && existsSync(stage)) rmSync(stage, { recursive: true, force: true })
  if (lockFd !== undefined) { closeSync(lockFd); rmSync(lock, { force: true }) }
}
