<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookCopy } from '@lucide/vue'
import EntityIndexView from '@/components/entity-index/EntityIndexView.vue'
import LibraryCreatorModal from '@/features/library/components/LibraryCreatorModal.vue'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { useLibraryCreationRedirect } from '@/features/library/composables/useLibraryCreationRedirect'
import { useLibraryCapabilities } from '../composables/useLibraryCapabilities'
import type { Library } from '@bookorbit/types'

defineOptions({ name: 'LibrariesView' })

const { t } = useI18n()
const { libraries, loading, fetchLibraries } = useLibraries()
const { capabilities, loading: capabilitiesLoading, error: capabilityError, canCreate, refresh: refreshCapabilities } = useLibraryCapabilities()
const { handleLibraryCreated } = useLibraryCreationRedirect()

const createOpen = ref(false)
const denial = computed(() => capabilities.value?.personalLibraryDenialReason)

function openCreate() {
  if (canCreate.value) createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

async function onLibrarySaved(library: Library) {
  createOpen.value = false
  await handleLibraryCreated(library)
}

onMounted(() => {
  void fetchLibraries()
})
</script>

<template>
  <div class="h-full">
    <LibraryCreatorModal v-if="createOpen" @close="closeCreate" @saved="onLibrarySaved" />
    <p v-if="capabilitiesLoading" role="status" class="px-4 text-sm text-muted-foreground">{{ t('library.personal.loading') }}</p>
    <p v-else-if="denial || capabilityError" role="status" class="px-4 text-sm text-muted-foreground">
      {{ denial || capabilityError }} <button type="button" class="underline" @click="refreshCapabilities">{{ t('library.personal.retry') }}</button>
    </p>
    <EntityIndexView
      :title="t('titles.libraries')"
      :title-icon="BookCopy"
      :fallback-icon="BookCopy"
      :items="libraries"
      route-name="library"
      :loading="loading"
      :search-placeholder="t('components.sidebar.filterLibrariesPlaceholder')"
      :empty-title="t('components.sidebar.noLibraries')"
      :empty-hint="t('components.entityIndex.librariesEmptyHint')"
      :can-add="canCreate"
      :add-label="t('components.sidebar.newLibrary')"
      @add="openCreate"
    />
  </div>
</template>
