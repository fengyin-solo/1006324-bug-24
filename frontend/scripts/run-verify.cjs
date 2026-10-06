/* 用 TypeScript 自带转译 + require 钩子直接跑 .ts 规则验证，无需 esbuild 原生二进制。 */
const path = require('path')
const fs = require('fs')
const Module = require('module')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')

// @/ 别名 → src/
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(SRC, request.slice(2))
  }
  return originalResolve.call(this, request, ...rest)
}

// .ts 即时转译为 CJS
Module._extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      sourceMap: false,
    },
    fileName: filename,
  })
  module._compile(out.outputText, filename)
}

// localStorage 内存桩
const memory = new Map()
const localStorageStub = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => {
    memory.set(k, String(v))
  },
  removeItem: (k) => {
    memory.delete(k)
  },
}
global.window = { localStorage: localStorageStub }
global.localStorage = localStorageStub

require(path.join(__dirname, 'verify-lighting.ts'))
