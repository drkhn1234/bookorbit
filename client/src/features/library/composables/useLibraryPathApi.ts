import { getCurrentInstance, inject, type InjectionKey, type Ref } from 'vue'
import { api } from '@/lib/api'

export const ADMINISTRATIVE_STORAGE: InjectionKey<Readonly<Ref<boolean>>> = Symbol('administrative-storage')
export function useLibraryPathApi() {
  const administrative = getCurrentInstance() ? inject(ADMINISTRATIVE_STORAGE, undefined) : undefined
  return (path: string, options?: RequestInit) => {
    const url = administrative?.value ? `${path}${path.includes('?') ? '&' : '?'}scope=admin` : path
    return options === undefined ? api(url) : api(url, options)
  }
}
