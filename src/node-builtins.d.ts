// Minimal built-in Node.js runtime declarations for the plugin worker so `tsc -p .` type-checks
// strictly with zero npm dependencies (`node_modules` free).

declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
}

interface NodeBuffer extends Uint8Array {
  subarray(begin?: number, end?: number): NodeBuffer
  toString(encoding?: 'utf8' | 'hex' | 'base64'): string
}

type Buffer = NodeBuffer

declare const Buffer: {
  allocUnsafe(size: number): NodeBuffer
  from(input: string | ArrayLike<number>, encoding?: 'utf8' | 'hex' | 'base64'): NodeBuffer
  concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): NodeBuffer
  byteLength(input: string, encoding?: 'utf8'): number
}

declare module 'node:fs' {
  export interface Stats {
    readonly dev: number
    readonly ino: number
    readonly size: number
    readonly mtimeMs: number
  }
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  export function existsSync(path: string): boolean
  export function statSync(path: string): Stats
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, content: string, encoding?: 'utf8'): void
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function mkdtempSync(prefix: string): string
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function openSync(path: string, flags: 'r'): number
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): number
  export function closeSync(fd: number): void
  export const realpathSync: ((path: string) => string) & {
    native(path: string): string
  }
  export function appendFileSync(path: string, data: string, encoding?: 'utf8'): void

  const fsDefault: {
    existsSync: typeof existsSync
    statSync: typeof statSync
    readdirSync: typeof readdirSync
    readFileSync: typeof readFileSync
    writeFileSync: typeof writeFileSync
    mkdirSync: typeof mkdirSync
    mkdtempSync: typeof mkdtempSync
    rmSync: typeof rmSync
    openSync: typeof openSync
    readSync: typeof readSync
    closeSync: typeof closeSync
    realpathSync: typeof realpathSync
    appendFileSync: typeof appendFileSync
  }
  export default fsDefault
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
  const osDefault: {
    homedir: typeof homedir
    tmpdir: typeof tmpdir
  }
  export default osDefault
}

declare module 'node:path' {
  export const sep: string
  export function join(...paths: string[]): string
  export function resolve(...paths: string[]): string
  export function basename(path: string, suffix?: string): string
  export function extname(path: string): string
  export function dirname(path: string): string
  const pathDefault: {
    sep: string
    join: typeof join
    resolve: typeof resolve
    basename: typeof basename
    extname: typeof extname
    dirname: typeof dirname
  }
  export default pathDefault
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
  const cryptoDefault: {
    createHash: typeof createHash
  }
  export default cryptoDefault
}

declare module 'node:module' {
  export function createRequire(filename: string | URL): (id: string) => unknown
}

declare module 'node:test' {
  export interface TestContext {
    name: string
  }
  export function describe(name: string, fn: () => void | Promise<void>): void
  export function it(name: string, fn: (t: TestContext) => void | Promise<void>): void
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void
  export function before(fn: () => void | Promise<void>): void
  export function after(fn: () => void | Promise<void>): void
}

declare module 'node:assert/strict' {
  function assert(value: unknown, message?: string): asserts value
  namespace assert {
    export function equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T
    export function deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T
    export function ok(value: unknown, message?: string): asserts value
    export function match(string: string, regexp: RegExp, message?: string): void
    export function rejects(
      block: (() => Promise<unknown>) | Promise<unknown>,
      error?: RegExp | ((err: unknown) => boolean),
      message?: string
    ): Promise<void>
  }
  export default assert
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}
