// Explicit maintenance action, using the same naming service as the desktop UI.
import { Storage } from '../src/main/storage'
import { NamingService } from '../src/main/naming'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
const directory = join(homedir(), 'Library/Application Support/Pi Desk')
const store = new Storage(directory); await store.init()
for (const name of ['preferences.json', 'session-titles.json']) {
  const file = join(directory, name)
  try { await fs.copyFile(file, `${file}.before-naming-${Date.now()}`) } catch (e: any) { if (e.code !== 'ENOENT') throw e }
}
const provider = process.argv[2], modelId = process.argv[3]
if (!provider || !modelId) throw new Error('请指定服务商和模型 ID。')
await store.save({ naming: { enabled: true, provider, modelId } })
const service = new NamingService(store, resolve('resources/naming-provider.mjs'), status => process.stdout.write(JSON.stringify(status) + '\n'), () => {})
process.on('SIGINT', () => service.cancel())
process.on('SIGTERM', () => service.cancel())
await service.batch()
await fs.writeFile(join(directory, 'naming-last-run.json'), JSON.stringify(service.status, null, 2), { mode: 0o600 })
