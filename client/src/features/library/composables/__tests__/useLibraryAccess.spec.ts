// @vitest-environment node
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>())

vi.mock('@/lib/api', () => ({ api: apiMock }))

const USERS = [
  { id: 2, username: 'maya', name: 'Maya Ortiz' },
  { id: 3, username: 'sam', name: 'Sam Whitfield' },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('useLibraryAccess', () => {
  beforeEach(() => {
    apiMock.mockReset()
  })

  it('loads the minimal creation directory and queues grants without writing yet', async () => {
    apiMock.mockResolvedValue(jsonResponse(USERS))
    const { useLibraryAccess } = await import('../useLibraryAccess')
    const access = useLibraryAccess(ref<number | null>(null))
    await access.load()
    expect(await access.grant(2, 'owner')).toBe(true)
    expect(apiMock.mock.calls).toEqual([['/api/v1/libraries/assignable-users']])
    expect(access.pending.value).toEqual([{ userId: 2, username: 'maya', name: 'Maya Ortiz', accessLevel: 'owner', failed: false }])
    expect(access.entries.value).toEqual([])
  })

  it('loads owner-scoped sharing options once the library exists', async () => {
    const libraryId = ref<number | null>(null)
    apiMock.mockImplementation(async (url) => jsonResponse(String(url).endsWith('/assignable-users') ? USERS : []))
    const { useLibraryAccess } = await import('../useLibraryAccess')
    const access = useLibraryAccess(libraryId)
    await access.load()
    expect(apiMock).toHaveBeenCalledWith('/api/v1/libraries/assignable-users')
    libraryId.value = 7
    await access.load()
    expect(apiMock).toHaveBeenCalledWith('/api/v1/libraries/7/assignable-users')
    expect(access.availableUsers.value.map((user) => user.id)).toEqual([2, 3])
    expect(access.pending.value).toEqual([])
  })

  it('writes straight to the server for an existing library and reports its message on failure', async () => {
    apiMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/assignable-users')) return jsonResponse(USERS)
      if (init?.method === 'PATCH') return jsonResponse({ message: 'Owners cannot be demoted' }, 400)
      return jsonResponse([])
    })
    const { useLibraryAccess } = await import('../useLibraryAccess')
    const access = useLibraryAccess(ref<number | null>(4))
    await access.load()

    await access.grant(2, 'viewer')
    const changed = await access.changeLevel(2, 'editor')

    expect(apiMock).toHaveBeenCalledWith('/api/v1/libraries/4/access', expect.objectContaining({ method: 'POST' }))
    expect(changed).toBe(false)
    expect(access.error.value).toBe('Owners cannot be demoted')
  })
})
