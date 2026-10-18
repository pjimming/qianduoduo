<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  groupColor,
  groupCompanyCount,
  groupLeafCount,
  techMap,
  techMapStats,
  type TechCompany,
} from '@/data/techmap'
import { firstReportForCompany } from '@/data/techMapReports'
import TechMapPrintOutline from '@/components/techmap/TechMapPrintOutline.vue'

interface CanvasNode {
  id: string
  level: 0 | 1 | 2 | 3
  side: 'center' | 'left' | 'right'
  name: string
  meta: string
  desc: string
  color: string
  board: string
  cos: TechCompany[]
  search: string
  children: CanvasNode[]
  parent: CanvasNode | null
  expanded: boolean
  visible: boolean
  x: number
  y: number
  h: number
  subH: number
}

interface LinkPath {
  id: string
  d: string
  stroke: string
  width: number
  opacity: number
}

const WIDTHS: Record<number, number> = { 0: 232, 1: 250, 2: 266, 3: 556 }
const LEVEL_GAPS: Record<number, number> = { 1: 160, 2: 100, 3: 90 }
const ROW_GAP = 12

const nodes = reactive<CanvasNode[]>([])
const byId = new Map<string, CanvasNode>()

function createNode(options: Partial<CanvasNode> & Pick<CanvasNode, 'level' | 'name'>): CanvasNode {
  const node = reactive<CanvasNode>({
    id: `tm-${nodes.length}`,
    side: 'center',
    meta: '',
    desc: '',
    color: '#176456',
    board: '',
    cos: [],
    search: '',
    children: [],
    parent: null,
    expanded: false,
    visible: false,
    x: 0,
    y: 0,
    h: 0,
    subH: 0,
    ...options,
  })
  nodes.push(node)
  byId.set(node.id, node)
  return node
}

const root = createNode({
  level: 0,
  name: 'A股科技',
  meta: `${techMapStats.groups} 大门类 · ${techMapStats.subs} 个子行业 · ${techMapStats.leaves} 个细分方向 · ${techMapStats.companies} 家代表公司`,
  color: '#1c2a24',
  expanded: true,
  side: 'center',
})

for (const group of techMap.groups) {
  const color = groupColor(group)
  const side: 'right' = 'right'
  const groupNode = createNode({
    level: 1,
    side,
    name: group.name,
    meta: `${group.subs.length} 个子行业 · ${groupLeafCount(group)} 个方向 · ${groupCompanyCount(group)} 家公司`,
    desc: group.desc,
    color,
    expanded: false,
    parent: root,
  })
  root.children.push(groupNode)

  for (const sub of group.subs) {
    const subNode = createNode({
      level: 2,
      side,
      name: sub.name,
      meta: `${sub.leaves.length} 方向`,
      color,
      parent: groupNode,
    })
    groupNode.children.push(subNode)

    for (const leaf of sub.leaves) {
      const leafNode = createNode({
        level: 3,
        side,
        name: leaf.name,
        board: leaf.board,
        cos: leaf.cos,
        color,
        parent: subNode,
        search: [leaf.name, leaf.board, ...leaf.cos.map((company) => company.n)]
          .join(' ')
          .toLowerCase(),
      })
      subNode.children.push(leafNode)
    }
  }
}

const stageRef = ref<HTMLElement | null>(null)
const scale = ref(1)
const translateX = ref(80)
const translateY = ref(0)
const grabbing = ref(false)
const searchInput = ref('')
const searchTerm = ref('')
const keptIds = ref<Set<string>>(new Set())
const hintText = ref('')

const worldStyle = computed(() => ({
  transform: `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`,
}))

const zoomText = computed(() => `${Math.round(scale.value * 100)}%`)

const hitText = computed(() => {
  if (!searchTerm.value) return ''
  const count = nodes.filter((node) => node.level === 3 && keptIds.value.has(node.id)).length
  return `匹配 ${count} / ${techMapStats.leaves} 个方向`
})

const links = computed<LinkPath[]>(() => {
  const paths: LinkPath[] = []
  for (const node of nodes) {
    if (!node.visible || !node.expanded) continue
    const visible = node.children.filter((child) => child.visible)
    for (const child of node.children) {
      if (!child.visible) continue
      const isLeft = child.side === 'left'
      const siblings = visible.filter((sibling) => sibling.side === child.side)
      const siblingIndex = siblings.indexOf(child)
      const x1 = isLeft ? node.x : node.x + WIDTHS[node.level]
      const y1 =
        node.y + (node.h * (siblingIndex + 1)) / Math.max(siblings.length + 1, 1)
      const x2 = isLeft ? child.x + WIDTHS[child.level] : child.x
      const y2 = child.y + child.h / 2
      const bend = Math.max(24, Math.abs(x2 - x1) * 0.45)
      const d = isLeft
        ? `M${x1} ${y1} C${x1 - bend} ${y1} ${x2 + bend} ${y2} ${x2} ${y2}`
        : `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`
      paths.push({
        id: `${node.id}-${child.id}`,
        d,
        stroke: child.level === 1 ? '#9eabb8' : child.color,
        width: child.level === 1 ? 1.8 : 1.5,
        opacity: child.level === 1 ? 0.9 : 0.68,
      })
    }
  }
  return paths
})

const contentBounds = computed(() => {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let height = 0
  for (const node of nodes) {
    if (!node.visible) continue
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x + WIDTHS[node.level])
    height = Math.max(height, node.y + node.h)
  }
  if (!Number.isFinite(minX)) minX = 0
  if (!Number.isFinite(maxX)) maxX = 0
  return {
    minX,
    maxX,
    width: Math.max(maxX - minX, 1),
    height: Math.max(height, 1),
  }
})

const contentSize = computed(() => ({
  width: Math.max(contentBounds.value.width + 80, 10),
  height: Math.max(contentBounds.value.height + 80, 10),
}))

const linkLeft = computed(() => contentBounds.value.minX - 40)

function visibleChildren(node: CanvasNode): CanvasNode[] {
  if (!node.expanded) return []
  return node.children.filter((child) => child.visible)
}

function setVisibility(node: CanvasNode, visible: boolean): void {
  node.visible = visible
  for (const child of node.children) {
    setVisibility(child, visible && node.expanded)
  }
}

function measureHeights(): void {
  const stage = stageRef.value
  if (!stage) return
  for (const element of stage.querySelectorAll<HTMLElement>('.tm-map-node')) {
    const node = element.dataset.nodeId ? byId.get(element.dataset.nodeId) : undefined
    if (!node || !node.visible) continue
    node.h = element.offsetHeight || 30
  }
}

function measureSubtree(node: CanvasNode): number {
  const children = visibleChildren(node)
  if (!children.length) {
    node.subH = node.h
    return node.subH
  }
  const left = children.filter((child) => child.side === 'left')
  const right = children.filter((child) => child.side === 'right')
  const totalOf = (list: CanvasNode[]) =>
    list.reduce((sum, child) => sum + measureSubtree(child), 0) +
    ROW_GAP * Math.max(list.length - 1, 0)
  node.subH = Math.max(node.h, totalOf(left), totalOf(right))
  return node.subH
}

function nodeX(node: CanvasNode): number {
  if (node.level === 0) return -WIDTHS[0] / 2
  const parent = node.parent
  if (!parent) return 0
  const gap = LEVEL_GAPS[node.level] ?? 90
  return node.side === 'left'
    ? parent.x - gap - WIDTHS[node.level]
    : parent.x + WIDTHS[parent.level] + gap
}

function placeNode(node: CanvasNode, top: number): void {
  node.x = nodeX(node)
  node.y = top + (node.subH - node.h) / 2
  const children = visibleChildren(node)
  if (!children.length) return

  for (const side of ['left', 'right'] as const) {
    const list = children.filter((child) => child.side === side)
    if (!list.length) continue
    const total =
      list.reduce((sum, child) => sum + child.subH, 0) + ROW_GAP * (list.length - 1)
    let cursor = top + (node.subH - total) / 2
    for (const child of list) {
      placeNode(child, cursor)
      cursor += child.subH + ROW_GAP
    }
  }
}

async function layout(): Promise<void> {
  setVisibility(root, true)
  await nextTick()
  measureHeights()
  measureSubtree(root)
  placeNode(root, 0)
}

function stageRect(): DOMRect | null {
  return stageRef.value?.getBoundingClientRect() ?? null
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  const rect = stageRect()
  if (!rect) return
  const mouseX = clientX - rect.left
  const mouseY = clientY - rect.top
  const nextScale = Math.min(3, Math.max(0.05, scale.value * factor))
  if (nextScale === scale.value) return
  translateX.value = mouseX - (mouseX - translateX.value) * (nextScale / scale.value)
  translateY.value = mouseY - (mouseY - translateY.value) * (nextScale / scale.value)
  scale.value = nextScale
}

function zoomBy(factor: number): void {
  const rect = stageRect()
  if (!rect) return
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
}

function centerOn(node: CanvasNode, targetScale?: number): void {
  const rect = stageRect()
  if (!rect) return
  if (targetScale) scale.value = targetScale
  translateX.value = rect.width / 2 - (node.x + WIDTHS[node.level] / 2) * scale.value
  translateY.value = rect.height / 2 - (node.y + node.h / 2) * scale.value
}

function initialScale(): number {
  const rect = stageRect()
  if (!rect) return 1
  if (rect.width >= 700) return 1
  const bounds = contentBounds.value
  const fitHeight = (rect.height - 24) / Math.max(bounds.height, 1)
  const maxScale = rect.width < 700 ? 0.9 : 1
  return Math.max(rect.width < 700 ? 0.7 : 0.4, Math.min(fitHeight, maxScale))
}

async function homeView(): Promise<void> {
  await layout()
  const rect = stageRect()
  if (!rect) return
  scale.value = initialScale()
  const bounds = contentBounds.value
  const contentHeight = bounds.height * scale.value
  translateX.value =
    (rect.width - bounds.width * scale.value) / 2 - bounds.minX * scale.value
  translateY.value =
    contentHeight > rect.height - 24 ? 12 : (rect.height - contentHeight) / 2 + 8
}

async function fit(): Promise<void> {
  const rect = stageRect()
  if (!rect) return
  await layout()
  const bounds = contentBounds.value
  const nextScale = Math.min(
    1.5,
    Math.max(
      0.04,
      Math.min(
        (rect.width - 64) / Math.max(bounds.width, 1),
        (rect.height - 64) / Math.max(bounds.height, 1),
      ),
    ),
  )
  scale.value = nextScale
  translateX.value = (rect.width - bounds.width * nextScale) / 2 - bounds.minX * nextScale
  translateY.value = (rect.height - bounds.height * nextScale) / 2 + 8
  if (nextScale < 0.22) {
    showHint(`内容较多，已缩到 ${Math.round(nextScale * 100)}%：滚轮放大看细节，或点门类节点逐层展开`)
  }
}

async function resetRoot(): Promise<void> {
  await homeView()
}

async function expandToSubs(): Promise<void> {
  for (const node of nodes) {
    if (node.level === 1) node.expanded = true
    if (node.level === 2) node.expanded = false
  }
  clearSearch(true)
  await fit()
  showHint('已展开到子行业层级：滚轮缩放，点击子行业看细分方向')
}

async function expandAll(): Promise<void> {
  for (const node of nodes) {
    if (node.level === 1 || node.level === 2) node.expanded = true
  }
  clearSearch(true)
  await fit()
  showHint('已展开全部层级：滚轮缩放、拖拽浏览')
}

async function toggleNode(node: CanvasNode): Promise<void> {
  if (movedFar || !node.children.length) return
  const beforeX = translateX.value + node.x * scale.value
  const beforeY = translateY.value + node.y * scale.value
  node.expanded = !node.expanded
  await layout()
  translateX.value = beforeX - node.x * scale.value
  translateY.value = beforeY - node.y * scale.value
  if (node.expanded) {
    const rect = stageRect()
    if (rect) {
      const subtreeHeight = node.subH * scale.value
      const targetTop =
        subtreeHeight <= rect.height - 24 ? (rect.height - subtreeHeight) / 2 : 12
      const subtreeTop = node.y - (node.subH - node.h) / 2
      translateY.value = targetTop - subtreeTop * scale.value

      const firstChild = visibleChildren(node)[0]
      if (firstChild) {
        const limit = rect.width - 24
        if (node.side === 'left') {
          const childLeft = firstChild.x * scale.value + translateX.value
          if (childLeft < 24) translateX.value += 24 - childLeft
        } else {
          const childRight =
            (firstChild.x + WIDTHS[firstChild.level]) * scale.value + translateX.value
          if (childRight > limit) translateX.value -= childRight - limit
        }
      }
    }
  }
}

const pointers = new Map<number, { x: number; y: number }>()
let downPoint: { x: number; y: number } | null = null
let movedFar = false
let pinch: { distance: number; midX: number; midY: number } | null = null

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointerMid(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function handlePointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  const stage = stageRef.value
  if (!stage) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  movedFar = false
  downPoint = { x: event.clientX, y: event.clientY }
  grabbing.value = true
  if (pointers.size === 2) {
    const [first, second] = [...pointers.values()]
    pinch = {
      distance: pointerDistance(first, second),
      midX: pointerMid(first, second).x,
      midY: pointerMid(first, second).y,
    }
  }
}

function handlePointerMove(event: PointerEvent): void {
  const previous = pointers.get(event.pointerId)
  if (!previous) return
  const deltaX = event.clientX - previous.x
  const deltaY = event.clientY - previous.y
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

  if (downPoint) {
    const moveX = event.clientX - downPoint.x
    const moveY = event.clientY - downPoint.y
    if (moveX * moveX + moveY * moveY > 16) movedFar = true
  }

  if (pointers.size === 1) {
    if (movedFar) {
      const stage = stageRef.value
      if (stage && !stage.hasPointerCapture(event.pointerId)) {
        stage.setPointerCapture(event.pointerId)
      }
      translateX.value += deltaX
      translateY.value += deltaY
    }
    return
  }

  if (pointers.size === 2) {
    const [first, second] = [...pointers.values()]
    const distance = pointerDistance(first, second)
    const mid = pointerMid(first, second)
    if (pinch && pinch.distance > 0) {
      zoomAt(mid.x, mid.y, distance / pinch.distance)
      translateX.value += mid.x - pinch.midX
      translateY.value += mid.y - pinch.midY
    }
    pinch = { distance, midX: mid.x, midY: mid.y }
  }
}

function handlePointerEnd(event: PointerEvent): void {
  pointers.delete(event.pointerId)
  if (pointers.size < 2) pinch = null
  if (pointers.size === 0) {
    grabbing.value = false
    downPoint = null
  }
}

function handleWheel(event: WheelEvent): void {
  zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0016))
}

let hintTimer: number | undefined
function showHint(message: string): void {
  hintText.value = message
  window.clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    hintText.value = ''
  }, 3200)
}

function markSubtree(node: CanvasNode, keep: Set<string>): void {
  keep.add(node.id)
  for (const child of node.children) markSubtree(child, keep)
}

function markAncestors(node: CanvasNode, keep: Set<string>): void {
  let parent = node.parent
  while (parent) {
    keep.add(parent.id)
    parent = parent.parent
  }
}

async function applySearch(rawTerm: string): Promise<void> {
  const term = rawTerm.trim().toLowerCase()
  searchTerm.value = term

  if (!term) {
    keptIds.value = new Set()
    await layout()
    return
  }

  const keep = new Set<string>()
  let firstMatch: CanvasNode | null = null

  for (const node of nodes) {
    if (node.level === 3) {
      if (node.search.includes(term)) {
        markSubtree(node, keep)
        markAncestors(node, keep)
        if (!firstMatch) firstMatch = node
      }
    } else if ((node.level === 1 || node.level === 2) && node.name.toLowerCase().includes(term)) {
      markSubtree(node, keep)
      markAncestors(node, keep)
    }
  }

  for (const node of nodes) {
    if (keep.has(node.id) && node.level < 3) node.expanded = true
  }

  keptIds.value = keep
  await layout()

  if (firstMatch) {
    if (scale.value < 0.55) scale.value = 0.55
    centerOn(firstMatch)
  }
}

let searchTimer: number | undefined
function scheduleSearch(): void {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    void applySearch(searchInput.value)
  }, 160)
}

function clearSearch(silent = false): void {
  searchInput.value = ''
  searchTerm.value = ''
  keptIds.value = new Set()
  if (!silent) void layout()
}

function nodeClass(node: CanvasNode): Record<string, boolean> {
  return {
    'is-left': node.side === 'left',
    'is-root': node.level === 0,
    'is-group': node.level === 1,
    'is-sub': node.level === 2,
    'is-leaf': node.level === 3,
    'is-open': node.expanded,
    'is-dim': keptIds.value.size > 0 && !keptIds.value.has(node.id),
    'is-hit': keptIds.value.size > 0 && keptIds.value.has(node.id) && node.level !== 0,
  }
}

function nodeStyle(node: CanvasNode): Record<string, string> {
  return {
    width: `${WIDTHS[node.level]}px`,
    left: `${node.x}px`,
    top: `${node.y}px`,
    '--node-color': node.color,
  }
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  const rect = stageRect()
  if (!rect) return
  if (event.key === '+' || event.key === '=') {
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.2)
  } else if (event.key === '-' || event.key === '_') {
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.2)
  } else if (event.key === '0') {
    void fit()
  }
}

let lastWidth = 0
let lastHeight = 0
function handleResize(): void {
  const rect = stageRect()
  if (!rect) return
  const wasNarrow = lastWidth > 0 && lastWidth < 640
  const isNarrow = rect.width < 640
  if (wasNarrow !== isNarrow) {
    lastWidth = rect.width
    lastHeight = rect.height
    void homeView()
    return
  }
  if (lastWidth && lastHeight) {
    translateX.value += (rect.width - lastWidth) / 2
    translateY.value += (rect.height - lastHeight) / 2
  }
  lastWidth = rect.width
  lastHeight = rect.height
}

onMounted(async () => {
  const rect = stageRect()
  if (rect) {
    lastWidth = rect.width
    lastHeight = rect.height
  }
  await homeView()
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('resize', handleResize)
  window.setTimeout(() => showHint('点击门类展开子行业 · 滚轮缩放 · 拖拽平移'), 500)
})

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer)
  window.clearTimeout(hintTimer)
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('resize', handleResize)
})

defineExpose({
  preparePrint() {},
  restoreAfterPrint() {},
})
</script>

<template>
  <div class="tm-view tm-canvas-view">
    <div class="tm-controlbar">
      <label class="tm-search">
        <input
          v-model="searchInput"
          type="search"
          placeholder="搜方向或公司：电子布 / CPO / 存储 / 中际旭创"
          autocomplete="off"
          aria-label="搜索科技图谱"
          @input="scheduleSearch"
          @keydown.esc="clearSearch()"
        />
        <button
          v-if="searchInput"
          class="tm-clear"
          type="button"
          aria-label="清空搜索"
          @click="clearSearch()"
        >
          ×
        </button>
      </label>
      <div class="tm-btn-group">
        <button class="tm-btn" type="button" @click="expandToSubs">展开到子行业</button>
        <button class="tm-btn" type="button" @click="expandAll">全部展开</button>
        <button class="tm-btn" type="button" @click="resetRoot">回到根节点</button>
        <button class="tm-btn" type="button" @click="fit">适应屏幕</button>
      </div>
      <div class="tm-zoom" aria-label="缩放">
        <button type="button" aria-label="缩小" @click="zoomBy(1 / 1.25)">−</button>
        <b>{{ zoomText }}</b>
        <button type="button" aria-label="放大" @click="zoomBy(1.25)">+</button>
      </div>
      <span class="tm-hit" role="status" aria-live="polite">{{ hitText }}</span>
    </div>

    <div
      ref="stageRef"
      class="tm-canvas-stage"
      :class="{ 'is-grabbing': grabbing }"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerEnd"
      @pointercancel="handlePointerEnd"
      @wheel.prevent="handleWheel"
    >
      <div class="tm-canvas-world" :style="worldStyle">
        <svg
          class="tm-canvas-links"
          :width="contentSize.width"
          :height="contentSize.height"
          :style="{ left: `${linkLeft}px` }"
          :viewBox="`${linkLeft} 0 ${contentSize.width} ${contentSize.height}`"
          aria-hidden="true"
        >
          <path
            v-for="link in links"
            :key="link.id"
            :d="link.d"
            fill="none"
            :stroke="link.stroke"
            :stroke-width="link.width"
            :stroke-opacity="link.opacity"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <div
          v-for="node in nodes"
          v-show="node.visible"
          :key="node.id"
          class="tm-map-node"
          :class="nodeClass(node)"
          :style="nodeStyle(node)"
          :data-node-id="node.id"
          @click.stop="toggleNode(node)"
        >
          <template v-if="node.level === 0">
            <div class="tm-node-title">{{ node.name }}</div>
            <div class="tm-node-meta">{{ node.meta }}</div>
          </template>

          <template v-else-if="node.level === 1">
            <div class="tm-node-head">
              <span class="tm-node-caret"></span>
              <span class="tm-node-title">{{ node.name }}</span>
            </div>
            <div class="tm-node-meta">{{ node.meta }}</div>
            <div class="tm-node-desc">{{ node.desc }}</div>
          </template>

          <template v-else-if="node.level === 2">
            <div class="tm-node-head">
              <span class="tm-node-caret"></span>
              <span class="tm-node-title">{{ node.name }}</span>
              <span class="tm-node-pill">{{ node.meta }}</span>
            </div>
          </template>

          <template v-else>
            <div class="tm-node-head tm-leaf-head">
              <span class="tm-node-title">{{ node.name }}</span>
              <span v-if="node.board" class="tm-node-board">{{ node.board }}</span>
            </div>
            <div class="tm-company-list">
              <span
                v-for="company in node.cos"
                :key="company.c"
                class="tm-company"
                :class="{ 'has-report': firstReportForCompany(company.c) }"
                :title="firstReportForCompany(company.c)?.title ?? ''"
              >
                {{ company.n }}<em>{{ company.c }}</em>
                <i
                  v-if="firstReportForCompany(company.c)"
                  class="tm-co-report-dot"
                  aria-label="有调研报告"
                ></i>
              </span>
            </div>
          </template>
        </div>
      </div>

      <div class="tm-canvas-hint" :class="{ 'is-on': hintText }" role="status">
        {{ hintText }}
      </div>
    </div>

    <TechMapPrintOutline />
  </div>
</template>
