<script setup lang="ts">
import { useLibraryPermissions } from '../composables/useLibraryPermissions'
import { useLibraryCapabilities } from '../composables/useLibraryCapabilities'
import { useLibraries } from '../composables/useLibraries'
import { useLibraryScan } from '@/features/scanner/composables/useLibraryScan'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useAuth } from '@/features/auth/composables/useAuth'
import { ADMINISTRATIVE_STORAGE } from '../composables/useLibraryPathApi'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { computed, inject, nextTick, onMounted, provide, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMediaQuery } from '@vueuse/core'
import { routerKey } from 'vue-router'
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  Ellipsis,
  FileCode,
  FilePenLine,
  FolderOpen,
  Images,
  Info,
  Library as LibraryIcon,
  Loader2,
  Plus,
  RefreshCw,
  ScanLine,
  Tags,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from '@lucide/vue'
import { isReadAlongFormatKey, type CoverAspectRatio, type Library, type OrganizationMode } from '@bookorbit/types'
import AppIcon from '@/components/AppIcon.vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useModal } from '@/composables/useModal'
import { formatNumber } from '@/i18n/formatters'
import { api } from '@/lib/api'
import { useLibraryAddedAt } from '../composables/useLibraryAddedAt'
import { useRegexMetadataReapply } from '../composables/useRegexMetadataReapply'
import { LIBRARY_ACCESS_KEY, useLibraryAccess } from '../composables/useLibraryAccess'
import { useLibraryCreator, type LibraryCreatorSectionId } from '../composables/useLibraryCreator'
import { writtenKindCount } from '../utils/library-summary'
import LibraryCreatorAccess from './LibraryCreatorAccess.vue'
import LibraryCreatorDetails from './LibraryCreatorDetails.vue'
import LibraryCreatorFileWrite from './LibraryCreatorFileWrite.vue'
import LibraryCreatorFolders from './LibraryCreatorFolders.vue'
import LibraryCreatorMetadata from './LibraryCreatorMetadata.vue'
import LibraryCreatorReading from './LibraryCreatorReading.vue'
import LibraryCreatorScanner from './LibraryCreatorScanner.vue'
import LibraryCreatorSchedule from './LibraryCreatorSchedule.vue'

const { t } = useI18n()
const route = inject(routerKey, null)?.currentRoute
const openingRoute = route?.value
let dismissed = false

const props = defineProps<{
  administrative?: boolean
  administratorMode?: boolean
  library?: Library | null
  /** The section to open on, e.g. from an Edit button beside that part of the library. */
  initialSection?: LibraryCreatorSectionId
  /** Create mode only: a library whose settings seed the new one. Its folders and access are not copied. */
  template?: Library | null
}>()

const emit = defineEmits<{
  removed: []
  disableAdministratorMode: []
  close: []
  saved: [library: Library]
  syncFiles: [library: Library]
  remove: [library: Library]
}>()

const SECTION_ICONS: Record<LibraryCreatorSectionId, Component> = {
  details: LibraryIcon,
  folders: FolderOpen,
  scanner: ScanLine,
  metadata: Tags,
  reading: BookOpen,
  schedule: Clock,
  fileWrite: FilePenLine,
  access: Users,
}
const SECTION_COMPONENTS: Record<LibraryCreatorSectionId, Component> = {
  details: LibraryCreatorDetails,
  folders: LibraryCreatorFolders,
  scanner: LibraryCreatorScanner,
  metadata: LibraryCreatorMetadata,
  reading: LibraryCreatorReading,
  schedule: LibraryCreatorSchedule,
  fileWrite: LibraryCreatorFileWrite,
  access: LibraryCreatorAccess,
}

const { user } = useAuth()
const { scanLibrary } = useLibraryScan()
const { hasLibraryPermission } = useLibraryPermissions()
const { hasPermission, isDemoRestrictedAccount, isSuperuser } = usePermissions()
const { libraries, loading: libraryLoading, error: libraryError, refreshLibraries } = useLibraries()
const {
  capabilities,
  canCreate,
  canUseAdministrativeStorage,
  loading: capabilityLoading,
  error: capabilityError,
  refresh: refreshCapabilities,
} = useLibraryCapabilities()
const administrativeStorage = ref(false)
provide(ADMINISTRATIVE_STORAGE, administrativeStorage)
const canEnableAdministratorMode = computed(() => Boolean(props.library) && isSuperuser.value && !isDemoRestrictedAccount.value)
const managementIntent = ref(props.administratorMode === true)
const administrativeManagement = computed(
  () =>
    (canEnableAdministratorMode.value && managementIntent.value) ||
    (!isSuperuser.value && props.administrative === true && hasPermission('manage_libraries')),
)
const initializationFailed = ref(false)
const canManage = computed(
  () =>
    !initializationFailed.value &&
    !libraryLoading.value &&
    !libraryError.value &&
    !isDemoRestrictedAccount.value &&
    (administrativeManagement.value || libraries.value.some((library) => library.id === props.library?.id && library.accessLevel === 'owner')),
)
const creator = useLibraryCreator()
const { form, mode, editingLibraryId, loading, folderChecks, stats, error, validationErrors } = creator
const access = useLibraryAccess(
  editingLibraryId,
  computed(() => (props.library ? administrativeManagement.value : administrativeStorage.value)),
)
provide(LIBRARY_ACCESS_KEY, access)
const canManageScanJobs = computed(() => administrativeManagement.value || hasLibraryPermission('manage_libraries', editingLibraryId.value, 'editor'))
const addedAtRecompute = useLibraryAddedAt(editingLibraryId, administrativeManagement)
const regexReapply = useRegexMetadataReapply(editingLibraryId, administrativeManagement)
/** Custom path rules the Series folders layout replaced in this session, kept outside the saved form. */
const replacedRegexMetadata = ref<Library['regexMetadata']>(null)

/** Below this the sheet cannot carry the rail, so sections become a drill-in list. */
const isWide = useMediaQuery('(min-width: 768px)')

const panel = ref<HTMLElement | null>(null)
const discardButton = ref<HTMLButtonElement | null>(null)
const activeSection = ref<LibraryCreatorSectionId | null>(null)
const initializing = ref(true)
const initializationWarning = ref(false)
const initialFormSnapshot = ref('')
const nestedModalOpen = ref(false)
const menuOpen = ref(false)
const attemptedSave = ref(false)
const pendingLeave = ref<(() => void) | null>(null)
const createdLibrary = ref<Library | null>(null)

const creating = computed(() => mode.value === 'create')
const isDirty = computed(() => !initializing.value && (initialFormSnapshot.value !== JSON.stringify(form) || access.pending.value.length > 0))
const requiredSetupValid = computed(() => !validationErrors.value.details && !validationErrors.value.folders)
const showActionsMenu = computed(() => Boolean(props.library) && !creating.value && !createdLibrary.value && canManage.value)

const SECTION_IDS: LibraryCreatorSectionId[] = ['details', 'folders', 'scanner', 'metadata', 'reading', 'schedule', 'fileWrite', 'access']

const modeLabel = computed(() =>
  form.organizationMode === 'book_per_file'
    ? t('library.creator.scanner.scanMode.fileAsBook.title')
    : t('library.creator.scanner.scanMode.folderAsBook.title'),
)

const checkedFileCount = computed(() => {
  let files = 0
  let checked = 0
  for (const folder of form.folders) {
    const check = folderChecks.value[folder]
    if (check?.state !== 'checked') continue
    checked += 1
    if (check.accessible) files += check.fileCount
  }
  return checked > 0 ? files : null
})

const leadFormat = computed(() => {
  const held = stats.value ? new Set(Object.keys(stats.value.formatCounts).filter((format) => (stats.value?.formatCounts[format] ?? 0) > 0)) : null
  // Read-along EPUBs are a subset of EPUBs the counts cannot see, so the summary names the plain format.
  const lead = form.formatPriority.find((key) => {
    if (isReadAlongFormatKey(key)) return false
    const imported = form.allowedFormats.length === 0 || form.allowedFormats.includes(key)
    return imported && (!held || held.has(key))
  })
  return lead ? lead.toUpperCase() : ''
})

const writtenKinds = computed(() => writtenKindCount(form))

const scheduleLabel = computed(() => {
  const cron = form.autoScanCronExpression
  const presets: Record<string, string> = {
    '0 * * * *': t('library.creator.schedule.presets.hourly'),
    '0 */6 * * *': t('library.creator.schedule.presets.every6Hours'),
    '0 */12 * * *': t('library.creator.schedule.presets.every12Hours'),
    '0 0 * * *': t('library.creator.schedule.presets.daily'),
    '0 0 * * 1': t('library.creator.schedule.presets.weekly'),
  }
  return cron ? (presets[cron] ?? t('library.creator.summary.customSchedule')) : null
})

function summaryFor(id: LibraryCreatorSectionId): string {
  switch (id) {
    case 'details':
      if (!form.name.trim()) return t('library.creator.summary.needsName')
      if (!form.icon?.trim()) return t('library.creator.summary.needsIcon')
      return form.coverAspectRatio === '1/1'
        ? t('library.creator.summary.detailsSquare', { name: form.name })
        : t('library.creator.summary.detailsPortrait', { name: form.name })
    case 'folders':
      if (form.folders.length === 0) return t(administrativeStorage.value ? 'library.creator.summary.needsFolder' : 'library.personal.defaultFolder')
      if (checkedFileCount.value !== null)
        return t('library.creator.summary.foldersFiles', { folders: form.folders.length, files: checkedFileCount.value })
      if (stats.value) return t('library.creator.summary.foldersBooks', { folders: form.folders.length, books: stats.value.totalBooks })
      return t('library.creator.summary.folders', { folders: form.folders.length })
    case 'scanner':
      return form.allowedFormats.length === 0
        ? t('library.creator.summary.scannerAll', { mode: modeLabel.value })
        : t('library.creator.summary.scannerSome', { mode: modeLabel.value, count: form.allowedFormats.length })
    case 'metadata':
      if (form.regexMetadata && form.metadataPrecedence[0] === 'regex')
        return t('library.creator.metadata.regex.summary', { format: leadFormat.value })
      return form.metadataPrecedence[0] === 'opfFile'
        ? t('library.creator.summary.metadataOpf', { format: leadFormat.value })
        : t('library.creator.summary.metadataFile', { format: leadFormat.value })
    case 'reading':
      return t('library.creator.summary.reading', { start: percent(form.readingThreshold), finish: percent(form.markAsFinishedPercentComplete) })
    case 'schedule': {
      if (form.watch && scheduleLabel.value) return t('library.creator.summary.watchingScheduled', { schedule: scheduleLabel.value })
      if (form.watch) return t('library.creator.summary.watchingOnly')
      if (scheduleLabel.value) return t('library.creator.summary.scheduledOnly', { schedule: scheduleLabel.value })
      return t('library.creator.summary.manualOnly')
    }
    case 'fileWrite':
      if (form.fileWriteEnabled && form.fileRenameEnabled) return t('library.creator.summary.writesAndRenames', { count: writtenKinds.value })
      if (form.fileWriteEnabled) return t('library.creator.summary.writes', { count: writtenKinds.value })
      if (form.fileRenameEnabled) return t('library.creator.summary.renames')
      return t('library.creator.summary.untouched')
    case 'access':
      if (editingLibraryId.value === null) {
        return access.pending.value.length > 0
          ? t('library.creator.summary.accessQueued', { count: access.pending.value.length })
          : t('library.personal.ownerOnly')
      }
      return access.loaded.value ? t('library.creator.summary.accessPeople', { count: access.entries.value.length }) : ''
  }
}

interface SectionEntry {
  id: LibraryCreatorSectionId
  label: string
  summary: string
  icon: Component
  /** A required section that is not filled in yet, while creating. */
  missing: boolean
  /** A section holding a validation error after a save was attempted. */
  invalid: boolean
}

const sections = computed<SectionEntry[]>(() =>
  SECTION_IDS.filter((id) => !createdLibrary.value || id === 'access')
    .filter((id) => id !== 'folders' || creating.value || administrativeStorage.value)
    .filter(
      (id) =>
        id !== 'fileWrite' ||
        creating.value ||
        administrativeManagement.value ||
        hasLibraryPermission('library_edit_metadata', editingLibraryId.value),
    )
    .map((id) => ({
      id,
      label: t(`library.creator.nav.${id}`),
      summary: summaryFor(id),
      icon: SECTION_ICONS[id],
      missing: creating.value && (id === 'details' || id === 'folders') && Boolean(validationErrors.value[id]),
      invalid: attemptedSave.value && Boolean(validationErrors.value[id]) && !(creating.value && (id === 'details' || id === 'folders')),
    })),
)

const activeEntry = computed(() => sections.value.find((section) => section.id === activeSection.value) ?? null)
const activeDescription = computed(() => {
  if (!activeSection.value) return ''
  return t(`library.creator.nav.descriptions.${activeSection.value}`)
})
const ActiveComponent = computed(() => (activeEntry.value ? SECTION_COMPONENTS[activeEntry.value.id] : null))
const showSectionList = computed(() => !isWide.value && activeSection.value === null)

const headerTitle = computed(() => {
  if (creating.value) return t('library.creator.sheet.createTitle')
  return form.name.trim() || props.library?.name || t('library.creator.sheet.editFallbackTitle')
})
const headerSubtitle = computed(() => {
  if (creating.value) return administrativeStorage.value ? t('library.creator.sheet.createHint') : t('library.personal.placement')
  if (stats.value)
    return t('library.creator.sheet.editSubtitle', { books: stats.value.totalBooks, folders: form.folders.length, mode: modeLabel.value })
  return t('library.creator.sheet.editSubtitleNoBooks', { folders: form.folders.length, mode: modeLabel.value })
})

const displayedError = computed(() => {
  if (error.value) return error.value
  if (!attemptedSave.value || !activeSection.value) return null
  return validationErrors.value[activeSection.value] ?? null
})

const createHint = computed(() => {
  if (requiredSetupValid.value) return t('library.creator.sheet.readyHint')
  return administrativeStorage.value ? t('library.creator.sheet.needsHint') : t('library.personal.needsHint')
})

const sectionProps = computed(() => ({
  details: { name: form.name, icon: form.icon, coverAspectRatio: form.coverAspectRatio },
  folders: {
    folders: form.folders,
    checks: folderChecks.value,
    stats: stats.value,
    libraryName: form.name,
    libraryIcon: form.icon,
    libraryId: editingLibraryId.value,
    organizationMode: form.organizationMode,
    organizationModeLocked: !creating.value,
    personalCreation: creating.value && !administrativeStorage.value,
  },
  scanner: {
    organizationMode: form.organizationMode,
    organizationModeLocked: !creating.value,
    allowedFormats: form.allowedFormats,
    addedAtSource: form.addedAtSource,
    canRecomputeAddedAt: !creating.value && canManageScanJobs.value,
    storedAddedAtSource: creator.storedAddedAtSource.value,
    recomputingAddedAt: addedAtRecompute.running.value,
    recomputeJob: addedAtRecompute.job.value,
    recomputeErrorKey: addedAtRecompute.errorKey.value,
    excludePatterns: form.excludePatterns,
    regexMetadata: form.regexMetadata ?? null,
    replacedRegexMetadata: replacedRegexMetadata.value,
  },
  metadata: {
    metadataPrecedence: form.metadataPrecedence,
    regexMetadata: form.regexMetadata ?? null,
    libraryId: creator.editingLibraryId.value ?? undefined,
    formatPriority: form.formatPriority,
    allowedFormats: form.allowedFormats,
    formatCounts: stats.value?.formatCounts ?? null,
    organizationMode: form.organizationMode,
    canConfigureRegex: administrativeStorage.value || canManageScanJobs.value,
    canReapplyRules: !creating.value && canManageScanJobs.value,
    storedRegexMetadata: creator.storedRegexMetadata.value ?? null,
    reapplyingRules: regexReapply.running.value,
    reapplyJob: regexReapply.job.value,
    reapplyErrorKey: regexReapply.errorKey.value,
  },
  reading: {
    readingThreshold: form.readingThreshold,
    markAsFinishedPercentComplete: form.markAsFinishedPercentComplete,
  },
  schedule: {
    watch: form.watch,
    autoScanCronExpression: form.autoScanCronExpression,
  },
  fileWrite: {
    fileRenameEnabled: form.fileRenameEnabled,
    fileWriteEnabled: form.fileWriteEnabled,
    fileWriteWriteCover: form.fileWriteWriteCover,
    fileWriteEpubEnabled: form.fileWriteEpubEnabled,
    fileWriteEpubMaxFileSizeMb: form.fileWriteEpubMaxFileSizeMb,
    fileWriteFb2Enabled: form.fileWriteFb2Enabled,
    fileWriteFb2MaxFileSizeMb: form.fileWriteFb2MaxFileSizeMb,
    fileWritePdfEnabled: form.fileWritePdfEnabled,
    fileWritePdfMaxFileSizeMb: form.fileWritePdfMaxFileSizeMb,
    fileWriteCbxEnabled: form.fileWriteCbxEnabled,
    fileWriteCbxMaxFileSizeMb: form.fileWriteCbxMaxFileSizeMb,
    fileWriteKindleEnabled: form.fileWriteKindleEnabled,
    fileWriteKindleMaxFileSizeMb: form.fileWriteKindleMaxFileSizeMb,
    fileWriteAudioEnabled: form.fileWriteAudioEnabled,
    fileWriteAudioMaxFileSizeMb: form.fileWriteAudioMaxFileSizeMb,
    fileWriteAllFiles: form.fileWriteAllFiles,
    fileWriteReadAlongEnabled: form.fileWriteReadAlongEnabled,
    fileWriteReadAlongMaxFileSizeMb: form.fileWriteReadAlongMaxFileSizeMb,
    formatCounts: stats.value?.formatCounts ?? null,
  },
  access: { libraryId: editingLibraryId.value, saving: loading.value },
}))

const activeProps = computed(() => (activeSection.value ? sectionProps.value[activeSection.value] : {}))

watch(
  () => JSON.stringify(form),
  () => {
    error.value = null
  },
)

watch(isWide, (wide) => {
  if (wide && activeSection.value === null) activeSection.value = 'details'
})

/** A library created with grants that failed stays open on Access; once a retry clears them, it is done. */
watch(
  () => access.failedGrants.value.length,
  (failed) => {
    if (failed === 0 && createdLibrary.value) emit('saved', createdLibrary.value)
  },
)

function percent(value: number): string {
  return formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 2 })
}

function selectSection(id: LibraryCreatorSectionId) {
  if (sections.value.some((section) => section.id === id)) activeSection.value = id
}

function backToSections() {
  activeSection.value = null
}

async function askToLeave(action: () => void) {
  pendingLeave.value = action
  await nextTick()
  discardButton.value?.focus()
}

function confirmLeave() {
  const action = pendingLeave.value
  pendingLeave.value = null
  action?.()
}

function cancelLeave() {
  pendingLeave.value = null
}

function leaveThen(action: () => void) {
  if (isDirty.value) void askToLeave(action)
  else action()
}

function closeEditor() {
  dismissed = true
  emit('close')
}

function requestClose() {
  if (loading.value || access.busy.value || nestedModalOpen.value) return
  if (pendingLeave.value) {
    cancelLeave()
    return
  }
  if (createdLibrary.value) {
    emit('saved', createdLibrary.value)
    return
  }
  leaveThen(closeEditor)
}

function goToFirstInvalidSection(): boolean {
  const invalid = SECTION_IDS.find((id) => validationErrors.value[id])
  if (!invalid) return false
  activeSection.value = invalid
  return true
}

async function handleSave() {
  if (
    loading.value ||
    access.busy.value ||
    (creating.value ? !(administrativeStorage.value ? canUseAdministrativeStorage.value : canCreate.value) : !canManage.value)
  )
    return
  const actorId = user.value?.id
  attemptedSave.value = true
  if (goToFirstInvalidSection()) return
  const wasCreating = creating.value
  const queuedGrants = access.pending.value
  const saved = await creator.save()
  if (user.value?.id !== actorId) return
  if (!saved) {
    await refreshCapabilities()
    if (!creating.value) await refreshLibraries()
    return
  }
  if (wasCreating && queuedGrants.length > 0) {
    // Grants need the library to exist, so the editor becomes an editor for it before sending them.
    creator.initEdit(saved)
    initialFormSnapshot.value = JSON.stringify(form)
    const failed = await access.applyPending(queuedGrants)
    if (user.value?.id !== actorId) return
    if (failed > 0) {
      createdLibrary.value = saved
      activeSection.value = 'access'
      return
    }
  }
  emit('saved', saved)
}

function finishCreate() {
  if (createdLibrary.value) emit('saved', createdLibrary.value)
}

function handleMenuOpen(value: boolean) {
  menuOpen.value = value
}

function runScan() {
  if (props.library) void scanLibrary(props.library, administrativeManagement.value)
}

function runRefreshCovers() {
  if (!props.library) return
  const suffix = administrativeManagement.value ? '?scope=admin' : ''
  void api(`/api/v1/scanner/libraries/${props.library.id}/refresh-covers${suffix}`, { method: 'POST' })
    .then((response) => {
      if (!response.ok) error.value = t('settings.admin.libraries.refreshCoversFailed', { name: props.library?.name })
    })
    .catch(() => {
      error.value = t('library.creator.errors.connection')
    })
}

function runSyncFiles() {
  const library = props.library
  if (library) leaveThen(() => emit('syncFiles', library))
}

const confirmingRemoval = ref(false)
const removalName = ref('')
function cancelRemoval() {
  confirmingRemoval.value = false
}
function runRemove() {
  const library = props.library
  if (!library || !canManage.value) return
  if (props.administrative && administrativeManagement.value) leaveThen(() => emit('remove', library))
  else {
    removalName.value = ''
    confirmingRemoval.value = true
  }
}
async function removeOwnedLibrary() {
  if (!props.library || !canManage.value || loading.value || removalName.value !== props.library.name) return
  const actorId = user.value?.id
  loading.value = true
  try {
    const response = await api(`/api/v1/libraries/${props.library.id}${administrativeManagement.value ? '?scope=admin' : ''}`, { method: 'DELETE' })
    if (!response.ok) {
      error.value = t('settings.admin.libraries.deleteFailed')
      return
    }
    if (user.value?.id !== actorId) return
    await refreshLibraries()
    emit('removed')
  } catch {
    error.value = t('library.creator.errors.connection')
  } finally {
    loading.value = false
    confirmingRemoval.value = false
  }
}

function handleFoldersUpdate(value: string[]) {
  const added = value.filter((folder) => !form.folders.includes(folder))
  form.folders = value
  if (added.length > 0) void creator.checkFolders(added)
}

function handleCheckFolders(paths: string[]) {
  void creator.checkFolders(paths)
}

function handleNestedModalChange(value: boolean) {
  nestedModalOpen.value = value
}

function handleRecomputeAddedAt() {
  if (!addedAtRecompute.running.value) void addedAtRecompute.start()
}

function handleReapplyRegexMetadata() {
  if (!regexReapply.running.value) void regexReapply.start()
}

function handleWatchUpdate(value: boolean) {
  form.watch = value
}

function handleWriteCoverUpdate(value: boolean) {
  form.fileWriteWriteCover = value
}

const sectionListeners = {
  'update:name': (value: string) => (form.name = value),
  'update:icon': (value: string | null) => (form.icon = value),
  'update:coverAspectRatio': (value: CoverAspectRatio) => (form.coverAspectRatio = value),
  'update:folders': handleFoldersUpdate,
  'update:organizationMode': (value: OrganizationMode) => (form.organizationMode = value),
  'update:addedAtSource': (value: Library['addedAtSource']) => (form.addedAtSource = value),
  recompute: handleRecomputeAddedAt,
  reapply: handleReapplyRegexMetadata,
  check: handleCheckFolders,
  'update:regexMetadata': (value: Library['regexMetadata']) => (form.regexMetadata = value),
  'update:replacedRegexMetadata': (value: Library['regexMetadata']) => (replacedRegexMetadata.value = value),
  'update:metadataPrecedence': (value: string[]) => (form.metadataPrecedence = value),
  'update:formatPriority': (value: string[]) => (form.formatPriority = value),
  'update:allowedFormats': (value: string[]) => (form.allowedFormats = value),
  'update:excludePatterns': (value: string[]) => (form.excludePatterns = value),
  'update:readingThreshold': (value: number) => (form.readingThreshold = value),
  'update:markAsFinishedPercentComplete': (value: number) => (form.markAsFinishedPercentComplete = value),
  'update:watch': handleWatchUpdate,
  'update:autoScanCronExpression': (value: string | null) => (form.autoScanCronExpression = value),
  'update:fileRenameEnabled': (value: boolean) => (form.fileRenameEnabled = value),
  'update:fileWriteEnabled': (value: boolean) => (form.fileWriteEnabled = value),
  'update:fileWriteWriteCover': handleWriteCoverUpdate,
  'update:fileWriteEpubEnabled': (value: boolean) => (form.fileWriteEpubEnabled = value),
  'update:fileWriteEpubMaxFileSizeMb': (value: number) => (form.fileWriteEpubMaxFileSizeMb = value),
  'update:fileWriteFb2Enabled': (value: boolean) => (form.fileWriteFb2Enabled = value),
  'update:fileWriteFb2MaxFileSizeMb': (value: number) => (form.fileWriteFb2MaxFileSizeMb = value),
  'update:fileWritePdfEnabled': (value: boolean) => (form.fileWritePdfEnabled = value),
  'update:fileWritePdfMaxFileSizeMb': (value: number) => (form.fileWritePdfMaxFileSizeMb = value),
  'update:fileWriteCbxEnabled': (value: boolean) => (form.fileWriteCbxEnabled = value),
  'update:fileWriteCbxMaxFileSizeMb': (value: number) => (form.fileWriteCbxMaxFileSizeMb = value),
  'update:fileWriteKindleEnabled': (value: boolean) => (form.fileWriteKindleEnabled = value),
  'update:fileWriteKindleMaxFileSizeMb': (value: number) => (form.fileWriteKindleMaxFileSizeMb = value),
  'update:fileWriteAudioEnabled': (value: boolean) => (form.fileWriteAudioEnabled = value),
  'update:fileWriteAudioMaxFileSizeMb': (value: number) => (form.fileWriteAudioMaxFileSizeMb = value),
  'update:fileWriteAllFiles': (value: boolean) => (form.fileWriteAllFiles = value),
  'update:fileWriteReadAlongEnabled': (value: boolean) => (form.fileWriteReadAlongEnabled = value),
  'update:fileWriteReadAlongMaxFileSizeMb': (value: number) => (form.fileWriteReadAlongMaxFileSizeMb = value),
  'update:pickerOpen': handleNestedModalChange,
  'update:regexOpen': handleNestedModalChange,
}

watch(
  [administrativeStorage, administrativeManagement, creating],
  () => {
    creator.personal.value = !administrativeStorage.value
    creator.administrative.value = administrativeStorage.value || (!creating.value && administrativeManagement.value)
  },
  { immediate: true },
)
watch(canUseAdministrativeStorage, (allowed) => {
  if (!allowed) administrativeStorage.value = false
})
watch(administrativeStorage, () => {
  if (!creating.value) return
  form.folders = []
  creator.resetFolderChecks()
})
watch(
  () => user.value?.id,
  () => emit('close'),
  { flush: 'sync' },
)
watch(
  () => libraries.value.find((library) => library.id === props.library?.id)?.accessLevel,
  (level, previous) => {
    if (previous != null && previous !== level && managementIntent.value) emit('close')
  },
  { flush: 'sync' },
)

function toggleAdministratorMode() {
  if (!canEnableAdministratorMode.value || loading.value || access.busy.value || nestedModalOpen.value) return
  if (managementIntent.value) {
    managementIntent.value = false
    administrativeStorage.value = false
    activeSection.value = 'details'
    if (props.administratorMode) emit('disableAdministratorMode')
    else void initialize()
  } else {
    managementIntent.value = true
    void access.load()
  }
}
function toggleAdministrativeStorage() {
  if (!canUseAdministrativeStorage.value || loading.value || access.busy.value || nestedModalOpen.value) return
  administrativeStorage.value = !administrativeStorage.value
  activeSection.value = administrativeStorage.value ? 'folders' : 'details'
}
useModal({
  container: panel,
  onClose: requestClose,
  disabled: () => nestedModalOpen.value || menuOpen.value || loading.value,
  shouldRestoreFocus: () =>
    dismissed && route?.value === openingRoute && (document.activeElement === document.body || !!panel.value?.contains(document.activeElement)),
})

async function initialize() {
  await refreshCapabilities()
  if (props.library) {
    await refreshLibraries()
    try {
      const response = await api(`/api/v1/libraries/${props.library.id}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      creator.initEdit(await response.json())
    } catch {
      mode.value = 'edit'
      editingLibraryId.value = props.library.id
      initializationFailed.value = true
      initializationWarning.value = true
      error.value = t('library.creator.errors.connection')
      return
    }
    void creator.loadStats()
    if (canManage.value) void access.load()
    return
  }
  if (props.template) {
    creator.initFromTemplate(props.template, t('library.creator.copyName', { name: props.template.name }))
    return
  }
  creator.initCreate()
}

function startingSection(): LibraryCreatorSectionId | null {
  const requested = props.initialSection && SECTION_IDS.includes(props.initialSection) ? props.initialSection : null
  if (requested && sections.value.some((section) => section.id === requested)) return requested
  return isWide.value ? 'details' : null
}

onMounted(async () => {
  try {
    await initialize()
  } finally {
    activeSection.value = startingSection()
    initialFormSnapshot.value = JSON.stringify(form)
    initializing.value = false
    if (creating.value && isWide.value) {
      await nextTick()
      panel.value?.querySelector<HTMLInputElement>('#library-name')?.focus()
    }
  }
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-70 bg-scrim motion-safe:animate-in motion-safe:fade-in-0" role="presentation" @click.self="requestClose">
      <div
        ref="panel"
        class="fixed inset-y-0 end-0 flex w-full flex-col bg-background shadow-2xl outline-none sm:max-w-[56rem] sm:border-s sm:border-border motion-safe:animate-in motion-safe:duration-300 ltr:motion-safe:slide-in-from-right rtl:motion-safe:slide-in-from-left"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-creator-title"
        aria-describedby="library-creator-description"
        tabindex="-1"
      >
        <header class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <button
            v-if="!isWide && activeSection !== null"
            type="button"
            class="-ms-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-muted"
            :aria-label="t('common.back')"
            @click="backToSections"
          >
            <ChevronLeft :size="18" class="rtl:rotate-180" aria-hidden="true" />
          </button>
          <span class="flex size-9.5 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary" aria-hidden="true">
            <AppIcon :icon="form.icon" :fallback="LibraryIcon" :size="18" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <h2 id="library-creator-title" class="truncate text-base font-semibold tracking-tight text-foreground">
                {{ !isWide && activeEntry ? activeEntry.label : headerTitle }}
              </h2>
              <span v-if="isDirty" class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {{ t('library.creator.unsaved') }}
              </span>
            </div>
            <p id="library-creator-description" class="mt-0.5 truncate text-xs text-muted-foreground">
              {{ !isWide && activeEntry ? headerTitle : headerSubtitle }}
            </p>
          </div>
          <button
            type="button"
            class="-me-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            :aria-label="t('library.creator.closeAria')"
            :disabled="loading"
            @click="requestClose"
          >
            <X :size="18" aria-hidden="true" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <nav
            v-if="isWide"
            class="w-56 shrink-0 overflow-y-auto border-e border-border bg-card p-2.5"
            :aria-label="t('library.creator.sectionsAria')"
          >
            <ul class="space-y-0.5">
              <li v-for="section in sections" :key="section.id">
                <div v-if="section.id === 'access'" class="mx-2 my-2 h-px bg-border" aria-hidden="true" />
                <button
                  type="button"
                  class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :class="activeSection === section.id ? 'bg-primary/10' : 'hover:bg-muted'"
                  :aria-current="activeSection === section.id ? 'true' : undefined"
                  @click="selectSection(section.id)"
                >
                  <component
                    :is="section.icon"
                    :size="16"
                    class="mt-0.5 shrink-0"
                    :class="activeSection === section.id ? 'text-primary' : 'text-foreground'"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1">
                    <span
                      class="flex items-center gap-1.5 text-sm font-medium"
                      :class="activeSection === section.id ? 'text-primary' : 'text-foreground'"
                    >
                      {{ section.label }}
                      <span v-if="section.missing" class="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                      <TriangleAlert v-else-if="section.invalid" :size="12" class="shrink-0 text-destructive" aria-hidden="true" />
                    </span>
                    <span class="mt-0.5 block truncate text-xs" :class="section.missing ? 'text-warning' : 'text-muted-foreground'">
                      {{ section.summary }}
                    </span>
                  </span>
                </button>
              </li>
            </ul>
          </nav>

          <main class="@container min-w-0 flex-1 overflow-y-auto">
            <div v-if="initializing" class="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 class="size-5 motion-safe:animate-spin" :aria-label="t('library.creator.loadingAria')" />
            </div>

            <ul v-else-if="showSectionList" class="flex flex-col gap-2 p-3" :aria-label="t('library.creator.sectionsAria')">
              <li v-for="section in sections" :key="section.id">
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @click="selectSection(section.id)"
                >
                  <component :is="section.icon" :size="17" class="shrink-0 text-foreground" aria-hidden="true" />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {{ section.label }}
                      <span v-if="section.missing" class="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                    </span>
                    <span class="mt-0.5 block truncate text-xs" :class="section.missing ? 'text-warning' : 'text-muted-foreground'">{{
                      section.summary
                    }}</span>
                  </span>
                  <ChevronRight :size="16" class="shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
                </button>
              </li>
            </ul>

            <div v-else class="flex flex-col gap-3.5 px-4 pb-7 pt-4 sm:px-5">
              <div
                v-if="initializationWarning"
                class="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
                role="status"
              >
                <Info :size="13" class="mt-px shrink-0" aria-hidden="true" />
                {{ t('library.creator.sheet.staleWarning') }}
              </div>
              <div v-if="isWide && activeEntry">
                <h3 class="text-base font-semibold tracking-tight text-foreground">{{ activeEntry.label }}</h3>
                <p class="mt-0.5 text-[13px] text-muted-foreground">{{ activeDescription }}</p>
              </div>
              <p v-else-if="activeEntry" class="text-[13px] text-muted-foreground">{{ activeDescription }}</p>
              <component
                :is="ActiveComponent"
                v-if="ActiveComponent && (creating ? canCreate || administrativeStorage : canManage || createdLibrary)"
                v-bind="activeProps"
                v-on="sectionListeners"
              />
            </div>
          </main>
        </div>

        <div class="shrink-0 border-t border-border px-4 py-2 text-sm" role="status">
          <p v-if="capabilityLoading">{{ t('library.personal.loading') }}</p>
          <p v-if="creating">{{ t('library.personal.owner') }}</p>
          <p v-if="capabilityError || (creating && !canCreate && !administrativeStorage)">
            {{ capabilityError || capabilities?.personalLibraryDenialReason }}
          </p>
          <p v-if="!creating && !canManage && !createdLibrary">
            {{
              libraryLoading ? t('library.personal.loading') : libraryError ? t('library.creator.errors.connection') : t('library.personal.notOwner')
            }}
          </p>
          <p v-if="canEnableAdministratorMode && administrativeManagement" class="text-primary">{{ t('library.personal.administratorActive') }}</p>
          <button v-if="canEnableAdministratorMode" type="button" class="underline" @click="toggleAdministratorMode">
            {{ t(administrativeManagement ? 'library.personal.disableAdministrator' : 'library.personal.enableAdministrator') }}
          </button>
          <button v-if="capabilityError" type="button" class="underline" @click="refreshCapabilities">{{ t('library.personal.retry') }}</button>
          <button
            v-if="canUseAdministrativeStorage && !createdLibrary && (creating || administrativeManagement)"
            type="button"
            class="underline"
            @click="toggleAdministrativeStorage"
          >
            {{ administrativeStorage ? t('library.personal.usePersonal') : t('library.personal.useAdministrative') }}
          </button>
        </div>
        <footer class="shrink-0 border-t border-border bg-card px-4 py-3 sm:px-5">
          <p v-if="displayedError && !pendingLeave" class="mb-2.5 flex items-start gap-2 text-xs text-destructive" role="alert">
            <TriangleAlert :size="14" class="mt-px shrink-0" aria-hidden="true" />
            <span>{{ displayedError }}</span>
          </p>

          <div v-if="pendingLeave" class="flex flex-wrap items-center gap-2" role="group" :aria-label="t('library.creator.sheet.discardQuestion')">
            <TriangleAlert :size="16" class="shrink-0 text-warning" aria-hidden="true" />
            <p class="min-w-0 flex-1 text-sm text-foreground">{{ t('library.creator.sheet.discardQuestion') }}</p>
            <button
              ref="discardButton"
              type="button"
              class="h-9 rounded-md bg-destructive px-3.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
              @click="confirmLeave"
            >
              {{ t('library.creator.sheet.discard') }}
            </button>
            <button
              type="button"
              class="h-9 rounded-md border border-border px-3.5 text-sm font-medium text-foreground hover:bg-muted"
              @click="cancelLeave"
            >
              {{ t('library.creator.sheet.keepEditing') }}
            </button>
          </div>

          <div v-else-if="initializing" class="flex h-9 items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="size-4 motion-safe:animate-spin" aria-hidden="true" />
            {{ t('library.creator.sheet.loading') }}
          </div>

          <div v-else class="flex flex-wrap items-center gap-2">
            <button
              v-if="createdLibrary"
              type="button"
              class="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              :disabled="access.busy.value"
              @click="finishCreate"
            >
              {{ t('library.creator.sheet.done') }}
            </button>
            <button
              v-else-if="creating"
              type="button"
              class="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="loading || capabilityLoading || (!canCreate && !administrativeStorage) || !requiredSetupValid"
              @click="handleSave"
            >
              <Plus :size="15" aria-hidden="true" />
              {{ loading ? t('library.creator.actions.creating') : t('library.creator.actions.createLibrary') }}
            </button>
            <button
              v-else
              type="button"
              class="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="loading || !canManage || !isDirty"
              @click="handleSave"
            >
              {{ loading ? t('library.creator.actions.saving') : t('library.creator.actions.saveChanges') }}
            </button>
            <button
              v-if="!createdLibrary"
              type="button"
              class="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              :disabled="loading"
              @click="requestClose"
            >
              {{ t('common.cancel') }}
            </button>

            <p v-if="creating" class="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck v-if="requiredSetupValid" :size="13" class="shrink-0" aria-hidden="true" />
              <Info v-else :size="13" class="shrink-0" aria-hidden="true" />
              {{ createHint }}
            </p>

            <DropdownMenu v-else-if="showActionsMenu && library" @update:open="handleMenuOpen">
              <DropdownMenuTrigger as-child>
                <button
                  type="button"
                  class="ms-auto flex size-9 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-muted"
                  :aria-label="t('settings.admin.libraries.moreActions', { name: library.name })"
                >
                  <Ellipsis :size="16" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" class="z-80 min-w-52">
                <DropdownMenuItem v-if="canManageScanJobs" @click="runScan">
                  <RefreshCw :size="14" aria-hidden="true" />
                  {{ t('library.creator.sheet.scanNow') }}
                </DropdownMenuItem>
                <DropdownMenuItem v-if="canManageScanJobs" @click="runRefreshCovers">
                  <Images :size="14" aria-hidden="true" />
                  {{ t('settings.admin.libraries.refreshCovers') }}
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="administrative && hasLibraryPermission('library_edit_metadata', editingLibraryId, 'editor')"
                  :disabled="!library.fileWriteEnabled"
                  @click="runSyncFiles"
                >
                  <FileCode :size="14" aria-hidden="true" />
                  {{ t('settings.admin.libraries.syncMetadataToFiles') }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" @click="runRemove">
                  <Trash2 :size="14" aria-hidden="true" />
                  {{ t('settings.admin.libraries.deleteLibrary') }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </footer>
      </div>
    </div>
    <ConfirmDialog
      v-if="confirmingRemoval && library"
      open
      destructive
      :title="t('settings.admin.libraries.deleteConfirmTitle', { name: library.name })"
      :description="t('settings.admin.libraries.deleteConfirmBody')"
      :confirm-label="t('settings.admin.libraries.deleteLibraryButton')"
      :confirm-disabled="removalName !== library.name"
      :busy="loading"
      @confirm="removeOwnedLibrary"
      @cancel="cancelRemoval"
    >
      <label class="mt-4 block"
        >{{ t('settings.admin.libraries.deleteConfirmTypeName')
        }}<input v-model="removalName" class="input-field mt-2 w-full" :placeholder="library.name"
      /></label>
    </ConfirmDialog>
  </Teleport>
</template>
