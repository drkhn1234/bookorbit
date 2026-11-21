import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { LIBRARY_OWNER_PERMISSIONS, Permission, type AuthUser, type Library } from '@bookorbit/types'

const user = ref<AuthUser | null>(null)
const apiMock = vi.hoisted(() => vi.fn<typeof import('@/lib/api').api>())
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user }) }))
vi.mock('@/lib/api', () => ({ api: apiMock }))
const { resetLibraries, useLibraries } = await import('../useLibraries')
const { useLibraryPermissions } = await import('../useLibraryPermissions')
const { usePermissions } = await import('@/features/auth/composables/usePermissions')

function account(isSuperuser = false, permissions: Permission[] = [Permission.LibraryEditMetadata]): AuthUser {
  return { id: 1, isSuperuser, permissions } as AuthUser
}
function grant(id: number, accessLevel?: Library['accessLevel']): Library {
  return { id, accessLevel } as Library
}

beforeEach(() => {
  resetLibraries()
  apiMock.mockReset()
  user.value = account()
  useLibraries().libraries.value = [grant(1, 'editor'), grant(2, 'viewer'), grant(3, 'owner')]
})

describe('useLibraryPermissions with real permission and library state', () => {
  it.each([false, true])('requires explicit library grants, superuser=%s', (superuser) => {
    user.value = account(superuser)
    const { hasLibraryPermission } = useLibraryPermissions()
    expect(hasLibraryPermission(Permission.LibraryEditMetadata, 1, 'editor')).toBe(true)
    expect(hasLibraryPermission(Permission.LibraryEditMetadata, 2, 'editor')).toBe(false)
    expect(hasLibraryPermission(Permission.LibraryEditMetadata, 3, 'owner')).toBe(true)
    for (const id of [4, null, undefined]) expect(hasLibraryPermission(Permission.LibraryEditMetadata, id, 'editor')).toBe(false)
  })

  it.each([false, true])('derives all six capabilities only in owned libraries, superuser=%s', (superuser) => {
    user.value = account(superuser, [])
    const { hasLibraryPermission } = useLibraryPermissions()
    for (const capability of LIBRARY_OWNER_PERMISSIONS) {
      expect(hasLibraryPermission(capability, 3)).toBe(true)
      expect(hasLibraryPermission(capability, 1)).toBe(false)
      expect(hasLibraryPermission(capability, 2)).toBe(false)
    }
    expect(hasLibraryPermission(Permission.ManageLibraries, 3)).toBe(false)
  })

  it('preserves global superuser administration while restricting content to grants', () => {
    user.value = account(true, [])
    expect(usePermissions().hasPermission(Permission.ManageLibraries)).toBe(true)
    expect(useLibraryPermissions().hasLibraryPermission(Permission.LibraryEditMetadata, 3, 'owner')).toBe(true)
    expect(useLibraryPermissions().hasLibraryPermission(Permission.LibraryEditMetadata, 4)).toBe(false)
  })

  it('fails closed for unloaded and incomplete grants', () => {
    user.value = account(true)
    const { hasPermissionInAnyLibrary, hasLibraryPermission } = useLibraryPermissions()
    useLibraries().libraries.value = []
    expect(hasPermissionInAnyLibrary(Permission.LibraryEditMetadata, 'editor')).toBe(false)
    useLibraries().libraries.value = [grant(1), grant(2, null)]
    expect(hasLibraryPermission(Permission.LibraryEditMetadata, 1)).toBe(false)
    expect(hasLibraryPermission(Permission.LibraryEditMetadata, 2)).toBe(false)
  })

  it('updates rendered actions after role and global permission changes', async () => {
    const Probe = defineComponent({
      setup() {
        const { hasLibraryPermission } = useLibraryPermissions()
        return () => h('div', hasLibraryPermission(Permission.LibraryEditMetadata, 1, 'editor') ? [h('button', 'Edit metadata')] : [])
      },
    })
    const wrapper = mount(Probe)
    expect(wrapper.find('button').exists()).toBe(true)
    useLibraries().libraries.value[0]!.accessLevel = 'viewer'
    await nextTick()
    expect(wrapper.find('button').exists()).toBe(false)
    useLibraries().libraries.value[0]!.accessLevel = 'owner'
    await nextTick()
    expect(wrapper.find('button').exists()).toBe(true)
    user.value = account(false, [])
    await nextTick()
    expect(wrapper.find('button').exists()).toBe(true)
    useLibraries().libraries.value[0]!.accessLevel = 'editor'
    await nextTick()
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('rejects a previous users late response after reset and new-user load', async () => {
    let finish!: (value: Response) => void
    apiMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const { refreshLibraries, libraries } = useLibraries()
    const stale = refreshLibraries()
    resetLibraries()
    user.value = { ...account(), id: 2 }
    apiMock.mockResolvedValueOnce(new Response(JSON.stringify([grant(9, 'viewer')]), { status: 200 }))
    await refreshLibraries()
    finish(new Response(JSON.stringify([grant(1, 'owner')]), { status: 200 }))
    await stale
    expect(libraries.value.map((library) => library.id)).toEqual([9])
    expect(useLibraryPermissions().hasPermissionInAnyLibrary(Permission.LibraryEditMetadata, 'editor')).toBe(false)
  })

  it('does not restore permissions after an old users failed request', async () => {
    let reject!: (cause: Error) => void
    apiMock.mockImplementationOnce(
      () =>
        new Promise<Response>((_, fail) => {
          reject = fail
        }),
    )
    const stale = useLibraries().refreshLibraries()
    resetLibraries()
    user.value = { ...account(true), id: 2 }
    reject(new Error('old account request failed'))
    await stale
    expect(useLibraries().error.value).toBeNull()
    expect(useLibraryPermissions().hasPermissionInAnyLibrary(Permission.LibraryEditMetadata)).toBe(false)
  })
})
