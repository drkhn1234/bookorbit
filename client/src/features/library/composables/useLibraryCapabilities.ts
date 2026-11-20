import { computed, ref, watch } from 'vue'
import type { LibraryCapabilities } from '@bookorbit/types'
import { api } from '@/lib/api'
import { createCoalescedFetch, createRequestGeneration } from '@/lib/async'
import { resetLibraries } from './useLibraries'
import { useAuth } from '@/features/auth/composables/useAuth'

const capabilities = ref<LibraryCapabilities | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const generation = createRequestGeneration()
let identity: number | null | undefined
const refresh = createCoalescedFetch(async () => {
  const request = generation.current()
  capabilities.value = null
  loading.value = true
  error.value = null
  try {
    const response = await api('/api/v1/libraries/capabilities')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as LibraryCapabilities
    if (typeof data?.canCreatePersonalLibrary !== 'boolean' || typeof data?.canUseAdministrativeStorage !== 'boolean')
      throw new Error('Invalid capability response')
    if (![data.personalLibraryDenialReason, data.administrativeStorageDenialReason].every((reason) => reason === null || typeof reason === 'string'))
      throw new Error('Invalid capability response')
    if (generation.isCurrent(request)) capabilities.value = data
  } catch (cause) {
    if (generation.isCurrent(request)) error.value = cause instanceof Error ? cause.message : 'Capability request failed'
  } finally {
    if (generation.isCurrent(request)) loading.value = false
  }
})

export function useLibraryCapabilities() {
  const { user } = useAuth()
  watch(
    user,
    (next, previous) => {
      if ((next?.id ?? null) !== identity) {
        if (identity !== undefined) resetLibraries()
        identity = next?.id ?? null
        generation.invalidate()
        capabilities.value = null
        loading.value = false
        error.value = null
        refresh.clear()
      }
      if (next && (!capabilities.value || previous)) void refresh()
    },
    { immediate: true, flush: 'sync' },
  )
  return {
    capabilities,
    loading,
    error,
    refresh,
    canCreate: computed(() => !loading.value && capabilities.value?.canCreatePersonalLibrary === true),
    canUseAdministrativeStorage: computed(() => !loading.value && capabilities.value?.canUseAdministrativeStorage === true),
  }
}
