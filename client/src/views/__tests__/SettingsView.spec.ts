import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import SettingsView from '@/views/SettingsView.vue'

const routeState = reactive<{ name: string; meta: Record<string, unknown> }>({
  name: 'settings-appearance-layout',
  meta: {},
})

const settingsUser = ref<{ id: number; isSuperuser: boolean } | null>(null)
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: settingsUser }) }))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
}))

function mountView(routeName: string, meta: Record<string, unknown> = {}) {
  routeState.name = routeName
  routeState.meta = meta
  return mount(SettingsView, {
    global: {
      stubs: {
        RouterView: { template: '<div data-testid="settings-outlet" />' },
      },
    },
  })
}

describe('SettingsView shell', () => {
  it('omits the scope ribbon and Administrator Mode action for ordinary users', () => {
    settingsUser.value = { id: 1, isSuperuser: false }
    const wrapper = mountView('settings-libraries')
    expect(wrapper.get('[data-testid="settings-page-content"]').text()).toBe('')
    expect(wrapper.find('button[aria-pressed]').exists()).toBe(false)
    wrapper.unmount()
    settingsUser.value = null
  })

  it('puts Administrator Mode after the existing header actions and keeps it synchronized across Library settings', async () => {
    settingsUser.value = { id: 1, isSuperuser: true }
    const wrapper = mountView('settings-libraries')
    const header = wrapper.get('[data-testid="settings-page-header"]')
    const button = () => header.get('button[aria-pressed]')
    expect(header.get('#settings-header-actions').element.nextElementSibling).toBe(button().element)
    expect(wrapper.get('[data-testid="settings-page-content"]').text()).toBe('')
    expect(button().text()).toBe('Enable Administrator Mode')
    expect(button().attributes('aria-pressed')).toBe('false')
    await button().trigger('click')
    for (const page of ['settings-metadata-providers', 'settings-metadata-field-rules', 'settings-file-naming', 'settings-maintenance']) {
      routeState.name = page
      await wrapper.vm.$nextTick()
      expect(button().text()).toBe('Disable Administrator Mode')
      expect(button().attributes('aria-pressed')).toBe('true')
    }

    settingsUser.value = { id: 2, isSuperuser: true }
    await wrapper.vm.$nextTick()
    expect(button().text()).toBe('Enable Administrator Mode')

    await button().trigger('click')
    settingsUser.value = { id: 2, isSuperuser: false }
    await wrapper.vm.$nextTick()
    expect(header.find('button[aria-pressed]').exists()).toBe(false)
    settingsUser.value = { id: 2, isSuperuser: true }
    await wrapper.vm.$nextTick()
    expect(button().text()).toBe('Enable Administrator Mode')

    await button().trigger('click')
    routeState.name = 'settings-appearance-layout'
    await wrapper.vm.$nextTick()
    routeState.name = 'settings-metadata-field-rules'
    await wrapper.vm.$nextTick()
    expect(button().text()).toBe('Enable Administrator Mode')
    settingsUser.value = null
    wrapper.unmount()
  })

  it('renders a single column page without a second navigation pane', () => {
    const wrapper = mountView('settings-appearance-layout')
    expect(wrapper.find('[data-testid="settings-page-header"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-outlet"]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'SettingsNav' }).exists()).toBe(false)
  })

  it('builds a breadcrumb from the settings root, group and parent of the active page', () => {
    const wrapper = mountView('settings-appearance-layout')
    const crumbs = wrapper.findAll('[data-testid="settings-breadcrumb-item"]').map((item) => item.text())
    expect(crumbs).toEqual(['Settings', 'You', 'Display'])
    expect(wrapper.get('nav').attributes('aria-label')).toBe('Breadcrumb')
  })

  it('keeps only the nearest crumb on phones', () => {
    const items = mountView('settings-appearance-layout').findAll('[data-testid="settings-breadcrumb-item"]')
    expect(items.map((item) => item.classes().includes('max-sm:hidden'))).toEqual([true, true, false])
  })

  it.each([
    [
      'settings-koreader',
      'KOReader',
      'Sync progress, reading activity and highlights with KOReader, get the sync URL and plugin, and manage the devices that connect.',
    ],
    [
      'settings-libraries',
      'Libraries',
      'Every library at a glance: its folders, what it holds, how it is scanned and when it last ran. Add, edit or rescan libraries here.',
    ],
    [
      'settings-metadata-providers',
      'Providers',
      'Turn metadata sources on or off, add API keys or cookies where a source needs them, and test the credentials against the live service.',
    ],
  ])('puts the %s title on the breadcrumb line with its description below', (routeName, title, description) => {
    const wrapper = mountView(routeName)
    const heading = wrapper.get('[data-testid="settings-page-title"]')
    expect(heading.element.tagName).toBe('H2')
    expect(heading.text()).toBe(title)
    expect(wrapper.get('nav').element.contains(heading.element)).toBe(false)
    expect(wrapper.get('[data-testid="settings-page-description"]').text()).toBe(description)
  })

  it('leaves the description line out for a page without one', () => {
    expect(mountView('settings-unlisted').find('[data-testid="settings-page-description"]').exists()).toBe(false)
  })

  it('keeps the teleport target for page header actions', () => {
    expect(mountView('settings-libraries').find('#settings-header-actions').exists()).toBe(true)
  })

  it('uses compact, consistent spacing below the shared page header', () => {
    const content = mountView('settings-account-profile').get('[data-testid="settings-page-content"]')

    expect(content.classes()).toContain('pt-4')
    expect(content.classes()).toContain('md:pt-5')
    expect(content.classes()).toContain('pb-6')
  })

  it('applies the route width so wide pages are not squeezed', () => {
    const wrapper = mountView('settings-admin-audit-log', { maxWidth: 'max-w-[96rem]' })
    expect(wrapper.html()).toContain('max-w-[96rem]')
  })

  it('falls back to the default width when the route does not set one', () => {
    const wrapper = mountView('settings-appearance-layout')
    expect(wrapper.html()).toContain('max-w-3xl')
  })
})
