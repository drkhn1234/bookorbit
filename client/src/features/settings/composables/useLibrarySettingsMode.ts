import { hasInjectionContext, inject, provide, readonly, ref, watch, type InjectionKey, type Ref } from 'vue'
import { useAuth } from '@/features/auth/composables/useAuth'
import { api } from '@/lib/api'

const personalMode = readonly(ref(false))
const modeKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol('library-settings-mode')

export function provideLibrarySettingsMode(isLibraryPage: Readonly<Ref<boolean>>) {
  const { user } = useAuth()
  const administratorMode = ref(false)
  watch(
    [() => user.value?.id, () => user.value?.isSuperuser, isLibraryPage],
    () => {
      administratorMode.value = false
    },
    { flush: 'sync' },
  )
  provide(modeKey, readonly(administratorMode))

  function toggleAdministratorMode() {
    if (user.value?.isSuperuser && isLibraryPage.value) administratorMode.value = !administratorMode.value
  }

  return { user, administratorMode, toggleAdministratorMode }
}

export function useLibrarySettingsMode() {
  return hasInjectionContext() ? inject(modeKey, personalMode) : personalMode
}

export function withLibraryAdministratorScope(url: string, enabled: boolean): string {
  return enabled ? `${url}${url.includes('?') ? '&' : '?'}scope=admin` : url
}

export function useLibrarySettingsApi() {
  // A request belongs to the scope of the mounted editor. The settings shell replaces it on scope changes.
  const mode = useLibrarySettingsMode()
  const administratorMode = mode.value
  const { user } = useAuth()
  const accountId = user.value?.id
  return (url: string, options?: Parameters<typeof api>[1]) => {
    if (user.value?.id !== accountId || mode.value !== administratorMode) {
      return Promise.reject(new DOMException('Settings scope changed', 'AbortError'))
    }
    const scopedUrl = withLibraryAdministratorScope(url, administratorMode)
    return options === undefined ? api(scopedUrl) : api(scopedUrl, options)
  }
}
