import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

it('retires only the old cover and thumbnail caches on worker activation', async () => {
  const names = new Set(['book-covers', 'book-thumbnails', 'app-shell', 'locale-catalogs', 'unrelated-cache'])
  let activation: ((event: { waitUntil(pending: Promise<unknown>): void }) => void) | undefined
  runInNewContext(await readFile('public/retire-media-caches.js', 'utf8'), {
    caches: { delete: async (name: string) => names.delete(name) },
    self: {
      addEventListener(type: string, listener: typeof activation) {
        expect(type).toBe('activate')
        activation = listener
      },
    },
  })

  expect(names.has('book-covers')).toBe(true)
  expect(activation).toBeTypeOf('function')
  let cleanup: Promise<unknown> | undefined
  activation!({ waitUntil: (pending) => (cleanup = pending) })
  expect(cleanup).toBeDefined()
  await cleanup

  expect([...names]).toEqual(['app-shell', 'locale-catalogs', 'unrelated-cache'])
})
