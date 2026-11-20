import { computed, type ComputedRef } from 'vue'
import { LIBRARY_OWNER_PERMISSIONS, type AccessLevel } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from './useLibraries'

let libraryAccess: ComputedRef<Map<number, AccessLevel | null | undefined>> | undefined
const accessRank: Record<AccessLevel, number> = { viewer: 1, editor: 2, owner: 3 }

export function useLibraryPermissions() {
  const { hasExplicitPermission, isDemoRestrictedAccount } = usePermissions()
  const { libraries } = useLibraries()
  const access = (libraryAccess ??= computed(() => new Map(libraries.value.map((library) => [library.id, library.accessLevel]))))

  function hasLibraryPermission(permission: string, libraryId: number | null | undefined, required: AccessLevel = 'viewer'): boolean {
    if (libraryId == null) return false
    const level = access.value.get(libraryId)
    if (level == null || accessRank[level] < accessRank[required]) return false
    if (LIBRARY_OWNER_PERMISSIONS.has(permission)) {
      if (level === 'viewer') return false
      if (level === 'owner' && !isDemoRestrictedAccount.value) return true
    }
    return hasExplicitPermission(permission)
  }

  function hasPermissionInAnyLibrary(permission: string, required: AccessLevel = 'viewer'): boolean {
    return libraries.value.some((library) => hasLibraryPermission(permission, library.id, required))
  }

  return { hasLibraryPermission, hasPermissionInAnyLibrary }
}
