<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  useTheme,
  type ThemePreference,
} from '@/composables/useTheme'

const props = withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false,
  },
)

const modes: Array<{
  value: ThemePreference
  label: string
  description: string
}> = [
  { value: 'light', label: '浅色', description: '始终使用浅色主题' },
  { value: 'dark', label: '深色', description: '始终使用深色主题' },
  {
    value: 'system',
    label: '跟随系统',
    description: '随系统外观自动切换',
  },
]

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menuOpen = ref(false)
const {
  preference,
  isDark,
  isSystem,
  setThemePreference,
} = useTheme()

const currentMode = computed(
  () => modes.find((mode) => mode.value === preference.value) ?? modes[2],
)
const triggerLabel = computed(
  () =>
    `主题模式：${currentMode.value.label}，当前显示${
      isDark.value ? '深色' : '浅色'
    }。打开主题选项`,
)

function chooseMode(mode: ThemePreference): void {
  setThemePreference(mode)
  menuOpen.value = false
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!menuOpen.value || root.value?.contains(event.target as Node)) return
  menuOpen.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !menuOpen.value) return
  menuOpen.value = false
  trigger.value?.focus()
}

onMounted(() => {
  if (!props.compact) return
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    ref="root"
    class="theme-control"
    :class="{ 'is-compact': compact }"
  >
    <button
      v-if="compact"
      ref="trigger"
      class="theme-toggle"
      type="button"
      :aria-label="triggerLabel"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      :title="triggerLabel"
      @click="menuOpen = !menuOpen"
    >
      <span class="theme-toggle-icon" aria-hidden="true">
        <svg v-if="isSystem" viewBox="0 0 20 20">
          <rect x="2.7" y="3.5" width="14.6" height="10.2" rx="1.5"></rect>
          <path d="M7 16.5h6M10 13.7v2.8"></path>
        </svg>
        <svg v-else-if="isDark" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="3.4"></circle>
          <path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2"></path>
          <path d="m4.5 4.5 1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4"></path>
        </svg>
        <svg v-else viewBox="0 0 20 20">
          <path d="M16.2 12.7A6.7 6.7 0 0 1 7.3 3.8 6.8 6.8 0 1 0 16.2 12.7Z"></path>
        </svg>
      </span>
    </button>

    <div
      v-else
      class="theme-mode-switch"
      role="group"
      aria-label="主题模式"
    >
      <button
        v-for="mode in modes"
        :key="mode.value"
        type="button"
        class="theme-mode-option"
        :class="{ 'is-active': preference === mode.value }"
        :data-theme-preference="mode.value"
        :aria-pressed="preference === mode.value"
        :title="mode.description"
        @click="chooseMode(mode.value)"
      >
        <span class="theme-mode-icon" aria-hidden="true">
          <svg v-if="mode.value === 'system'" viewBox="0 0 20 20">
            <rect x="2.7" y="3.5" width="14.6" height="10.2" rx="1.5"></rect>
            <path d="M7 16.5h6M10 13.7v2.8"></path>
          </svg>
          <svg v-else-if="mode.value === 'dark'" viewBox="0 0 20 20">
            <path d="M16.2 12.7A6.7 6.7 0 0 1 7.3 3.8 6.8 6.8 0 1 0 16.2 12.7Z"></path>
          </svg>
          <svg v-else viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="3.4"></circle>
            <path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2"></path>
            <path d="m4.5 4.5 1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4"></path>
          </svg>
        </span>
        <span>{{ mode.label }}</span>
      </button>
    </div>

    <div
      v-if="compact && menuOpen"
      class="theme-mode-menu"
      role="menu"
      aria-label="主题模式"
    >
      <span class="theme-menu-heading">主题模式</span>
      <button
        v-for="mode in modes"
        :key="mode.value"
        type="button"
        class="theme-menu-option"
        :class="{ 'is-active': preference === mode.value }"
        role="menuitemradio"
        :aria-checked="preference === mode.value"
        @click="chooseMode(mode.value)"
      >
        <span class="theme-menu-copy">
          <strong>{{ mode.label }}</strong>
          <small>{{ mode.description }}</small>
        </span>
        <span v-if="preference === mode.value" class="theme-menu-check" aria-hidden="true">
          ✓
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.theme-control {
  position: relative;
  width: 100%;
}

.theme-mode-switch {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--card-soft);
}

.theme-mode-option {
  display: grid;
  min-width: 0;
  min-height: 50px;
  padding: 6px 3px;
  place-items: center;
  gap: 3px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
  transition:
    border-color 160ms ease,
    background 160ms ease,
    color 160ms ease;
}

.theme-mode-option:hover {
  background: var(--green-wash);
  color: var(--ink);
}

.theme-mode-option.is-active {
  border-color: rgba(var(--green-rgb), 0.25);
  background: var(--green-soft);
  color: var(--green);
}

.theme-mode-option:focus-visible,
.theme-toggle:focus-visible,
.theme-menu-option:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}

.theme-mode-icon,
.theme-toggle-icon {
  display: grid;
  place-items: center;
}

.theme-mode-icon svg,
.theme-toggle-icon svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.55;
}

.theme-toggle {
  display: grid;
  width: 38px;
  min-height: 38px;
  padding: 0;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card-soft);
  color: var(--muted);
  cursor: pointer;
}

.theme-toggle:hover,
.theme-toggle[aria-expanded='true'] {
  border-color: var(--line-strong);
  background: var(--green-wash);
  color: var(--green);
}

.theme-control.is-compact {
  width: auto;
}

.theme-mode-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 110;
  display: grid;
  width: 204px;
  padding: 7px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--card);
  box-shadow: var(--shadow);
}

.theme-menu-heading {
  padding: 5px 8px 7px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.1em;
}

.theme-menu-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 45px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
  text-align: left;
}

.theme-menu-option:hover {
  background: var(--green-wash);
  color: var(--ink);
}

.theme-menu-option.is-active {
  border-color: rgba(var(--green-rgb), 0.22);
  background: var(--green-soft);
  color: var(--green);
}

.theme-menu-copy {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.theme-menu-copy strong {
  font-size: 13px;
  font-weight: 650;
}

.theme-menu-copy small {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.theme-menu-check {
  color: var(--green);
  font-size: 14px;
  font-weight: 750;
}
</style>
