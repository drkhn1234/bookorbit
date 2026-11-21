import { ref, defineComponent, h, nextTick } from 'vue'
import { flushPromises, shallowMount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import type { AuthUser, Library, LibraryCapabilities } from '@bookorbit/types'
import { i18n } from '@/i18n'

const user = ref<AuthUser | null>(null)
const apiMock = vi.hoisted(() => vi.fn<typeof import('@/lib/api').api>())
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user }) }))
vi.mock('@/lib/api', () => ({ api: apiMock }))
const { default: Dialog } = await import('../LibraryCreatorModal.vue')
const { default: Details } = await import('../LibraryCreatorDetails.vue')
const { default: Folders } = await import('../LibraryCreatorFolders.vue')
const { useLibraryCapabilities } = await import('../../composables/useLibraryCapabilities')
const { useLibraryCreator } = await import('../../composables/useLibraryCreator')
const { useLibraries } = await import('../../composables/useLibraries')
let number = 100
let caps: LibraryCapabilities
let library: Library
let grants: Library[]
const wrappers: Array<{ unmount(): void }> = []
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status })
}
function requestPayload(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  return JSON.parse(init.body)
}
function buttons(wrapper: ReturnType<typeof shallowMount>, text: string) {
  return wrapper.findAll('button').find((button) => button.text().includes(text))!
}
async function dialog(props: Record<string, unknown> = {}) {
  const wrapper = shallowMount(Dialog, { props, global: { stubs: { teleport: true } } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  i18n.global.locale.value = 'en'
  user.value = {
    id: ++number,
    username: 'reader',
    name: 'Reader',
    active: true,
    isSuperuser: false,
    isDefaultPassword: false,
    settings: {},
    provisioningMethod: 'local',
    permissions: [],
  }
  caps = {
    canCreatePersonalLibrary: true,
    personalLibraryDenialReason: null,
    canUseAdministrativeStorage: false,
    administrativeStorageDenialReason: 'Administrator filesystem scope requires a superuser',
  }
  library = {
    ...useLibraryCreator().form,
    id: 9,
    name: 'Owned library',
    icon: 'BookOpen',
    accessLevel: 'owner',
    folders: [{ id: 1, path: '/books/own/library', createdAt: '' }],
    createdAt: '',
    updatedAt: '',
  } as Library
  grants = [library]
  window.matchMedia = vi.fn<typeof window.matchMedia>().mockReturnValue({
    matches: true,
    media: '',
    onchange: null,
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
    addListener: vi.fn<() => void>(),
    removeListener: vi.fn<() => void>(),
    dispatchEvent: vi.fn<() => boolean>().mockReturnValue(true),
  })
  apiMock.mockReset().mockImplementation(async (url, init) => {
    if (url === '/api/v1/libraries/capabilities') return json(caps)
    if (url === '/api/v1/libraries' && !init?.method) return json(grants)
    if (url === '/api/v1/libraries/9') return json(library)
    if (String(url).endsWith('/stats')) return json({ formatCounts: {}, totalBooks: 0, totalSizeBytes: 0 })
    if (String(url).endsWith('/assignable-users')) return json([])
    if (String(url).endsWith('/access')) return json([{ userId: user.value!.id, accessLevel: 'owner', name: 'Owner', username: 'reader' }])
    if (String(url).includes('/prescan')) return json({ paths: [], totalFiles: 0 })
    if (init?.method === 'POST') return json(library, 201)
    return json({})
  })
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})

it('creates personally without global administration, paths or a separate creator grant', async () => {
  const wrapper = await dialog()
  expect(wrapper.text()).toContain('automatically own')
  expect(wrapper.text()).toContain('Needs a name and an icon.')
  expect(wrapper.text()).not.toContain('point it at a folder')
  expect(wrapper.findComponent(Folders).exists()).toBe(false)
  expect(wrapper.findAll('nav button').some((button) => button.text().startsWith('Folders'))).toBe(true)
  const details = wrapper.getComponent(Details)
  details.vm.$emit('update:name', 'Personal physics')
  details.vm.$emit('update:icon', 'BookOpen')
  await nextTick()
  await buttons(wrapper, 'Create library').trigger('click')
  await flushPromises()
  const call = apiMock.mock.calls.find(([url, init]) => url === '/api/v1/libraries/personal' && init?.method === 'POST')!
  expect(call).toBeDefined()
  const payload = requestPayload(call[1])
  expect(payload.name).toBe('Personal physics')
  for (const key of ['folders', 'userId', 'ownerId', 'accessLevel']) expect(payload).not.toHaveProperty(key)
  expect(apiMock.mock.calls.some(([url]) => String(url).includes('/access'))).toBe(false)
  expect(wrapper.emitted('saved')![0]![0]).toMatchObject({ accessLevel: 'owner' })
})

it('keeps superusers personal by default and requires an explicit storage choice', async () => {
  user.value = { ...user.value!, isSuperuser: true }
  caps.canUseAdministrativeStorage = true
  const wrapper = await dialog()
  expect(wrapper.findComponent(Folders).exists()).toBe(false)
  expect(apiMock.mock.calls.some(([url]) => String(url).includes('/path/'))).toBe(false)
  await buttons(wrapper, 'Use administrative storage').trigger('click')
  await flushPromises()
  expect(wrapper.findComponent(Folders).exists()).toBe(true)
  wrapper.getComponent(Folders).vm.$emit('update:folders', ['/operator/import'])
  await wrapper
    .findAll('nav button')
    .find((button) => button.text().startsWith('Library'))!
    .trigger('click')
  wrapper.getComponent(Details).vm.$emit('update:name', 'Admin import')
  wrapper.getComponent(Details).vm.$emit('update:icon', 'BookOpen')
  await nextTick()
  await buttons(wrapper, 'Create library').trigger('click')
  await flushPromises()
  const call = apiMock.mock.calls.find(([url, init]) => url === '/api/v1/libraries?scope=admin' && init?.method === 'POST')!
  expect(requestPayload(call[1]).folders).toEqual(['/operator/import'])
})

it('shows backend denial and prevents programmatic creation for ineligible accounts', async () => {
  caps.canCreatePersonalLibrary = false
  caps.personalLibraryDenialReason = 'Personal storage requires administrator attention'
  const wrapper = await dialog()
  expect(wrapper.text()).toContain(caps.personalLibraryDenialReason)
  expect(buttons(wrapper, 'Create library').attributes('disabled')).toBeDefined()
  expect(wrapper.findComponent(Details).exists()).toBe(false)
  expect(buttons(wrapper, 'Use administrative storage')).toBeUndefined()
  expect(apiMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})

it('allows an explicit owner to edit and share without global ManageLibraries', async () => {
  const wrapper = await dialog({ library })
  expect(wrapper.findComponent(Details).exists()).toBe(true)
  expect(wrapper.findAll('nav button').some((button) => button.text().startsWith('Access'))).toBe(true)
  expect(apiMock.mock.calls.some(([url]) => url === '/api/v1/libraries/9/assignable-users')).toBe(true)
  expect(apiMock.mock.calls.some(([url]) => url === '/api/v1/users/assignable')).toBe(false)
  wrapper.getComponent(Details).vm.$emit('update:name', 'Updated physics')
  await nextTick()
  await buttons(wrapper, 'Save changes').trigger('click')
  await flushPromises()
  const call = apiMock.mock.calls.find(([url, init]) => url === '/api/v1/libraries/9' && init?.method === 'PATCH')!
  expect(requestPayload(call[1])).not.toHaveProperty('folders')
})

it('does not treat a superuser viewer as the library owner', async () => {
  user.value = { ...user.value!, isSuperuser: true }
  grants = [{ ...library, accessLevel: 'viewer' }]
  const wrapper = await dialog({ library })
  expect(wrapper.text()).toContain('Owner access is required')
  expect(wrapper.findComponent(Details).exists()).toBe(false)
  expect(apiMock.mock.calls.some(([url]) => String(url).endsWith('/access'))).toBe(false)
})

it('ignores a late capability response across an authenticated-user switch', async () => {
  let complete!: (value: Response) => void
  apiMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve
      }),
  )
  const Probe = defineComponent({
    setup() {
      const state = useLibraryCapabilities()
      return () => h('div', state.canCreate.value ? 'can create' : 'cannot create')
    },
  })
  const wrapper = mount(Probe)
  wrappers.push(wrapper)
  caps.canCreatePersonalLibrary = false
  user.value = { ...user.value!, id: ++number }
  await flushPromises()
  expect(wrapper.text()).toBe('cannot create')
  complete(json({ ...caps, canCreatePersonalLibrary: true }))
  await flushPromises()
  expect(wrapper.text()).toBe('cannot create')
  expect(useLibraries().libraries.value).toEqual([])
})

it('fails closed on capability API errors and recovers after retry', async () => {
  apiMock.mockImplementation(async () => json({}, 503))
  let state!: ReturnType<typeof useLibraryCapabilities>
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useLibraryCapabilities()
        return () => h('div', state.canCreate.value ? 'can create' : (state.error.value ?? ''))
      },
    }),
  )
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('503')
  apiMock.mockImplementation(async () => json(caps))
  await state.refresh()
  expect(state.canCreate.value).toBe(true)
})

it('keeps creation single-flight and displays a server failure without losing the form', async () => {
  const original = apiMock.getMockImplementation()!
  let finish!: (response: Response) => void
  apiMock.mockImplementation((url, init) =>
    init?.method === 'POST' && url === '/api/v1/libraries/personal'
      ? new Promise<Response>((resolve) => {
          finish = resolve
        })
      : original(url, init),
  )
  const wrapper = await dialog()
  wrapper.getComponent(Details).vm.$emit('update:name', 'Retry this book library')
  wrapper.getComponent(Details).vm.$emit('update:icon', 'BookOpen')
  await nextTick()
  await buttons(wrapper, 'Create library').trigger('click')
  await buttons(wrapper, 'Creating').trigger('click')
  expect(apiMock.mock.calls.filter(([url, init]) => url === '/api/v1/libraries/personal' && init?.method === 'POST')).toHaveLength(1)
  finish(json({ message: 'Storage is temporarily unavailable' }, 503))
  await flushPromises()
  expect(wrapper.text()).toContain('Storage is temporarily unavailable')
  expect(wrapper.getComponent(Details).props('name')).toBe('Retry this book library')
  expect(wrapper.emitted('saved')).toBeUndefined()
})

it('removes owner controls when a refreshed library list revokes ownership', async () => {
  const wrapper = await dialog({ library })
  expect(wrapper.findComponent(Details).exists()).toBe(true)
  grants = [{ ...library, accessLevel: 'viewer' }]
  await useLibraries().refreshLibraries()
  await nextTick()
  expect(wrapper.findComponent(Details).exists()).toBe(false)
  expect(buttons(wrapper, 'Save changes').attributes('disabled')).toBeDefined()
})

it('gates the library index creation button using the server capability, not global admin permissions', async () => {
  const { default: Index } = await import('../../views/LibrariesView.vue')
  const wrapper = shallowMount(Index, {
    global: {
      stubs: {
        EntityIndexView: {
          name: 'EntityIndexView',
          props: ['canAdd'],
          emits: ['add'],
          template: '<section><button v-if="canAdd" @click="$emit(\'add\')">New library</button></section>',
        },
        LibraryCreatorModal: { name: 'LibraryCreatorModal', emits: ['close'], template: '<aside>Personal editor</aside>' },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.find('button').exists()).toBe(true)
  await wrapper.find('button').trigger('click')
  expect(wrapper.find('aside').exists()).toBe(true)
  wrapper.findComponent({ name: 'LibraryCreatorModal' }).vm.$emit('close')
  caps.canCreatePersonalLibrary = false
  caps.personalLibraryDenialReason = 'Creation disabled by server policy'
  user.value = { ...user.value!, isSuperuser: true }
  await flushPromises()
  expect(wrapper.find('section button').exists()).toBe(false)
  wrapper.findComponent({ name: 'EntityIndexView' }).vm.$emit('add')
  await nextTick()
  expect(wrapper.find('aside').exists()).toBe(false)
  expect(wrapper.text()).toContain('Creation disabled by server policy')
})

async function mountLibraryIndex() {
  const { default: Index } = await import('../../views/LibrariesView.vue')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/libraries', component: Index },
      { path: '/library/:id', name: 'library', component: { template: '<h1>Opened library</h1>' } },
    ],
  })
  await router.push('/libraries')
  const wrapper = mount(
    defineComponent(() => () => h(RouterView)),
    {
      attachTo: document.body,
      global: { plugins: [router], stubs: { PageMenuButton: true } },
    },
  )
  wrappers.push(wrapper)
  await flushPromises()
  const trigger = buttons(wrapper, 'New Library').element
  async function open() {
    trigger.focus()
    trigger.click()
    await flushPromises()
    expect(document.activeElement).toBe(document.querySelector('#library-name'))
  }
  return { trigger, open, router }
}

it('returns focus to the same New Library button after capability refresh and repeated dismissal', async () => {
  const { trigger, open } = await mountLibraryIndex()
  await open()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  await flushPromises()
  expect(document.activeElement).toBe(trigger)

  await open()
  document.querySelector<HTMLButtonElement>('button[aria-label="Close library creator"]')!.click()
  await flushPromises()
  expect(document.activeElement).toBe(trigger)

  await open()
  document.querySelector<HTMLElement>('[role="presentation"]:has(> [aria-labelledby="library-creator-title"])')!.click()
  await flushPromises()
  expect(document.activeElement).toBe(trigger)
})

it('keeps Tab and Shift+Tab within the library creator at its focus boundaries', async () => {
  const { trigger, open } = await mountLibraryIndex()
  await open()
  const first = document.querySelector<HTMLButtonElement>('button[aria-label="Close library creator"]')!
  const last = document.querySelector<HTMLInputElement>('#library-name')!
  // JSDOM has no layout. Treat two real dialog controls as visible for the focus trap.
  for (const element of [first, last]) vi.spyOn(element, 'getClientRects').mockReturnValue([new DOMRect()] as unknown as DOMRectList)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
  expect(document.activeElement).toBe(first)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))
  expect(document.activeElement).toBe(last)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  await flushPromises()
  expect(document.activeElement).toBe(trigger)
})

it('does not return focus to the opener when navigation removes the dialog', async () => {
  const { trigger, open, router } = await mountLibraryIndex()
  await open()
  const refocus = vi.spyOn(trigger, 'focus')
  await router.push('/library/9')
  await flushPromises()
  expect(document.querySelector('#library-creator-title')).toBeNull()
  expect(document.querySelector('h1')?.textContent).toBe('Opened library')
  expect(refocus).not.toHaveBeenCalled()
})

it('does not try to focus an opener that was removed while the dialog was open', async () => {
  const { trigger, open } = await mountLibraryIndex()
  await open()
  trigger.remove()
  const refocus = vi.spyOn(trigger, 'focus')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  await flushPromises()
  expect(document.querySelector('#library-creator-title')).toBeNull()
  expect(refocus).not.toHaveBeenCalled()
})

it('requires typed confirmation before an owner can delete the library', async () => {
  const original = apiMock.getMockImplementation()!
  apiMock.mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') {
      grants = []
      return new Response(null, { status: 204 })
    }
    return original(url, init)
  })
  const passthrough = { template: '<div><slot /></div>' }
  const wrapper = shallowMount(Dialog, {
    props: { library },
    global: {
      stubs: {
        teleport: true,
        DropdownMenu: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuTrigger: passthrough,
        DropdownMenuItem: { template: '<button><slot /></button>' },
        ConfirmDialog: {
          props: ['confirmDisabled'],
          emits: ['confirm', 'cancel'],
          template: '<section><slot/><button :disabled="confirmDisabled" @click="$emit(\'confirm\')">Confirm deletion</button></section>',
        },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  await buttons(wrapper, 'Delete library').trigger('click')
  expect(buttons(wrapper, 'Confirm deletion').attributes('disabled')).toBeDefined()
  expect(apiMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  await wrapper.get('input[placeholder="Owned library"]').setValue('Owned library')
  await buttons(wrapper, 'Confirm deletion').trigger('click')
  await flushPromises()
  expect(apiMock).toHaveBeenCalledWith('/api/v1/libraries/9', { method: 'DELETE' })
  expect(wrapper.emitted('removed')).toHaveLength(1)
})
