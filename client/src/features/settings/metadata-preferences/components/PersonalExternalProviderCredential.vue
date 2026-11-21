<script setup lang="ts">
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { ProviderStatus } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { SECRET_INPUT_ATTRS } from '@/lib/secret-input'
import { useLibrarySettingsApi } from '@/features/settings/composables/useLibrarySettingsMode'

const props = defineProps<{ provider: ProviderStatus }>()
const emit = defineEmits<{ changed: [] }>()
const api = useLibrarySettingsApi()
const authorization = ref('')
const saving = ref(false)
const placeholder = computed(() => {
  if (props.provider.credentialSource === 'administrator') return 'Using administrator-provided credential'
  if (props.provider.credentialSource === 'personal') return 'Personal credential saved'
  return 'Enter an Authorization header value'
})

async function saveCredential(value: string) {
  saving.value = true
  try {
    const res = await api(`/api/v1/metadata-preferences/providers/external/${encodeURIComponent(props.provider.key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorization: value }),
    })
    if (!res.ok) throw new Error('Credential update rejected')
    authorization.value = ''
    emit('changed')
  } catch {
    toast.error('Unable to update the provider credential')
  } finally {
    saving.value = false
  }
}

function save() {
  if (authorization.value.trim()) void saveCredential(authorization.value)
}

function remove() {
  void saveCredential('')
}
</script>

<template>
  <form class="space-y-2 rounded-md border border-border p-3" @submit.prevent="save">
    <label :for="`provider-authorization-${provider.key}`" class="block text-sm font-medium">{{ provider.label }} authorization</label>
    <div class="flex flex-wrap items-center gap-2">
      <input
        :id="`provider-authorization-${provider.key}`"
        v-model="authorization"
        v-bind="SECRET_INPUT_ATTRS"
        type="password"
        class="input-field min-w-48 flex-1"
        :placeholder="placeholder"
        :maxlength="8192"
      />
      <Button type="submit" size="sm" :disabled="saving || !authorization.trim()">Save credential</Button>
      <Button v-if="provider.credentialSource === 'personal'" type="button" variant="outline" size="sm" :disabled="saving" @click="remove">
        Remove
      </Button>
    </div>
  </form>
</template>
