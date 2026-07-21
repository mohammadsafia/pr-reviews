import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import { buildApp } from './app.js'

const app = buildApp()
const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist })
}
const port = Number(process.env.PORT ?? 5175)
app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`PR Reviewer running at http://127.0.0.1:${port}`)
})
