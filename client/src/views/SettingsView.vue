<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { ChevronRight, Settings } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { provideLibrarySettingsMode } from '@/features/settings/composables/useLibrarySettingsMode'
import PageTitleRow from '@/components/page-header/PageTitleRow.vue'
import { findSettingsNavItem } from '@/features/settings/lib/settings-nav'

const { t, te } = useI18n()
const route = useRoute()

const contentScroll = ref<HTMLElement | null>(null)

const maxWidth = computed(() => (route.meta.maxWidth as string | undefined) ?? 'max-w-3xl')
const match = computed(() => findSettingsNavItem(typeof route.name === 'string' ? route.name : ''))
const isLibraryPage = computed(() => match.value?.group.id === 'library')
const { user, administratorMode, toggleAdministratorMode } = provideLibrarySettingsMode(isLibraryPage)
const instancePages = new Set([
  'settings-metadata-custom-fields',
  'settings-metadata-score',
  'settings-metadata-authors',
  'settings-metadata-search-cache',
])
const requiresAdministratorMode = computed(() => instancePages.has(String(route.name)))
const pageTitle = computed(() => (match.value ? t(match.value.item.titleKey ?? match.value.item.labelKey) : t('settings.nav.title')))
const pageIcon = computed(() => match.value?.item.icon ?? Settings)
/**
 * The header wants a sentence; the nav search keeps the terse one. A locale without the longer
 * sentence yet shows its own short one rather than falling back to English.
 */
const pageDescription = computed(() => {
  const item = match.value?.item
  if (!item) return ''
  const fuller = `settings.nav.pageDescriptions.${item.id}`
  if (te(fuller)) return t(fuller)
  return item.descriptionKey ? t(item.descriptionKey) : ''
})

const breadcrumb = computed(() => {
  if (!match.value) return []
  const trail = [t('settings.nav.title'), t(match.value.group.labelKey)]
  if (match.value.parent) trail.push(t(match.value.parent.labelKey))
  return trail
})

watch(
  () => route.name,
  () => {
    if (contentScroll.value) contentScroll.value.scrollTop = 0
  },
)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden rounded-lg border border-border/70 bg-card/40 shadow-sm">
    <div class="shrink-0 border-b border-border/70 bg-card/60 px-4 py-2.5 md:px-6" data-testid="settings-page-header">
      <PageTitleRow heading-tag="h2" heading-test-id="settings-page-title" :title="pageTitle" :icon="pageIcon">
        <template #titleLead>
          <!-- The trail gives way before the title does; phones keep only the nearest crumb. -->
          <nav v-if="breadcrumb.length" :aria-label="t('settings.nav.breadcrumbLabel')" class="min-w-0 shrink-[999]">
            <ol class="flex min-w-0 items-baseline gap-1.5 text-[15px] font-medium text-muted-foreground">
              <li
                v-for="(crumb, index) in breadcrumb"
                :key="crumb"
                class="flex min-w-0 items-baseline gap-1.5"
                :class="{ 'max-sm:hidden': index < breadcrumb.length - 1 }"
                data-testid="settings-breadcrumb-item"
              >
                <span class="truncate">{{ crumb }}</span>
                <ChevronRight :size="14" class="shrink-0 self-center rtl:rotate-180" aria-hidden="true" />
              </li>
            </ol>
          </nav>
        </template>
        <template v-if="pageDescription" #subtitle>
          <span data-testid="settings-page-description">{{ pageDescription }}</span>
        </template>
        <template #actions>
          <!-- Pages teleport their primary action here so it sits beside the title
               instead of being wedged into the page body. -->
          <div id="settings-header-actions" class="flex shrink-0 items-center gap-2" />
        </template>
      </PageTitleRow>
    </div>

    <div ref="contentScroll" class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div data-testid="settings-page-content" class="px-4 pb-6 pt-4 md:px-6 md:pt-5" :class="maxWidth">
        <div v-if="isLibraryPage" class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
          <p role="status" class="text-sm font-medium">
            {{ administratorMode ? 'Administrator Mode · Instance settings' : 'Personal library settings' }}
          </p>
          <Button v-if="user?.isSuperuser" size="sm" :variant="administratorMode ? 'secondary' : 'outline'" @click="toggleAdministratorMode">
            {{ administratorMode ? 'Disable Administrator Mode' : 'Enable Administrator Mode' }}
          </Button>
        </div>
        <p v-if="requiresAdministratorMode && !administratorMode" class="text-sm text-muted-foreground">
          These settings apply to the instance. An eligible superuser can manage them in Administrator Mode.
        </p>
        <router-view v-else v-slot="{ Component, route: childRoute }">
          <div :key="isLibraryPage ? `${childRoute.path}:${user?.id}:${administratorMode}` : childRoute.path">
            <component :is="Component" />
          </div>
        </router-view>
      </div>
    </div>
  </div>
</template>
