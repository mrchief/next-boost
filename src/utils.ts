import cp from 'child_process'
import fs from 'fs'
import http from 'http'
import Cache from 'hybrid-disk-cache'
import path from 'path'
import { PassThrough } from 'stream'
import { HandlerConfig } from './types'

function shouldZip(req: http.IncomingMessage): boolean {
  const field = req.headers['accept-encoding']
  return field !== undefined && field.indexOf('gzip') !== -1
}

function isZipped(res: http.ServerResponse): boolean {
  const field = res.getHeader('content-encoding')
  if (typeof field === 'number') return false
  return field !== undefined && field.indexOf('gzip') !== -1
}

function wrappedResponse(
  res: http.ServerResponse,
  cache: { [key: string]: unknown }
): http.ServerResponse {
  const chunks: Array<Buffer> = []

  const push = (...args: any[]) => {
    const [chunk, encoding] = args
    if (!chunk) return
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
  }

  const _end = res.end
  const _write = res.write

  res.write = (...args: any[]) => {
    push(...args)
    return _write.apply(res, args)
  }

  res.end = (...args: any[]) => {
    push(...args)
    cache.body = Buffer.concat(chunks)
    return _end.apply(res, args)
  }

  return res
}

function log(start: [number, number], status: string, msg?: string): void {
  const [secs, ns] = process.hrtime(start)
  const ms = ns / 1000000
  const time = `${secs > 0 ? secs + 's' : ''}${ms.toFixed(1)}ms`
  console.log('%s | %s: %s', time.padStart(7), status.padEnd(6), msg)
}

function serveCache(
  cache: Cache,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const notAllowed = ['GET', 'HEAD'].indexOf(req.method) === -1
  const updating = req.headers['x-cache-status'] === 'update'
  const status = cache.has('body:' + req.url)
  if (notAllowed || updating || status === 'miss') return false

  const body = cache.get('body:' + req.url)
  const headers = JSON.parse(cache.get('header:' + req.url).toString())
  for (const k in headers) {
    res.setHeader(k, headers[k])
  }
  res.statusCode = 200

  res.removeHeader('content-length')
  res.setHeader('content-encoding', 'gzip')
  const stream = new PassThrough()
  stream.pipe(res)
  stream.end(body)

  return status
}

function mergeConfig(c: HandlerConfig = {}) {
  const conf: HandlerConfig = {
    hostname: 'localhost',
    port: 3000,
    cache: { ttl: 60, tbd: 3600 },
    rules: [{ regex: '.*', ttl: 3600 }],
  }

  if (!c.filename) c.filename = '.next-boost.js'
  const configFile = path.resolve(c.filename)
  if (fs.existsSync(configFile)) {
    try {
      const f = require(configFile) as HandlerConfig
      c.cache = Object.assign(f.cache || {}, c.cache || {})
      c = Object.assign(f, c)
      console.log('> Loaded next-boost config from %s', c.filename)
    } catch (error) {
      throw new Error(`Failed to load ${c.filename}`)
    }
  }

  // deep merge cache and remove it
  Object.assign(conf.cache, c.cache)
  delete c.cache
  Object.assign(conf, c)

  return conf
}

function fork(modulePath: string) {
  const isTest = process.env.NODE_ENV === 'test'
  const options = isTest ? { execArgv: ['-r', 'ts-node/register'] } : null
  return cp.fork(modulePath, [], options)
}

export {
  isZipped,
  shouldZip,
  log,
  mergeConfig,
  serveCache,
  wrappedResponse,
  fork,
}
