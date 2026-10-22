<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { IncomeInboxItem } from '@/types/dashboard'

const props = defineProps<{
  items: IncomeInboxItem[]
}>()

function isAmountConflict(item: IncomeInboxItem): boolean {
  const messages = [item.error, ...(item.parsed.warnings || [])].join('；')
  return (
    item.status === 'pending' &&
    Boolean(item.record_date) &&
    /金额不一致|不同收益|已有收益/.test(messages)
  )
}

function isSameAmountIgnored(item: IncomeInboxItem): boolean {
  return Boolean(
    item.status === 'applied' &&
      item.parsed.warnings?.some(
        (warning) => warning.includes('金额一致') && warning.includes('已忽略'),
      ),
  )
}

const historyItems = computed(() =>
  props.items.filter(
    (item) => item.status !== 'pending' || isAmountConflict(item),
  ),
)

const conflictCount = computed(
  () => historyItems.value.filter(isAmountConflict).length,
)

function statusLabel(item: IncomeInboxItem): string {
  if (isAmountConflict(item)) return '金额冲突 · 待确认'
  if (isSameAmountIgnored(item)) return '同金额已忽略'
  if (item.status === 'applied') return '已入账'
  if (item.status === 'ignored') return '已忽略'
  return '待确认'
}

function statusTone(item: IncomeInboxItem): string {
  if (isAmountConflict(item)) return 'is-conflict'
  if (isSameAmountIgnored(item)) return 'is-ignored'
  return item.status === 'applied' ? 'is-applied' : 'is-ignored'
}

function productCodes(item: IncomeInboxItem): string[] {
  return Array.from(
    new Set(
      (item.parsed.products || [])
        .map((product) => String(product.product_code || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  )
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value.replace('T', ' ').slice(0, 16)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .replaceAll('/', '-')
}

function noteText(item: IncomeInboxItem): string {
  return [item.notes, item.parsed.notes, item.error]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join('；')
}
</script>

<template>
  <details v-if="historyItems.length" class="income-history">
    <summary>
      <span class="income-history-summary">
        <strong>收益截图处理记录</strong>
        <span>
          原图仅保存在本机；已入账、已忽略、同金额忽略和金额冲突都可展开核对。
        </span>
      </span>
      <span class="income-history-count">
        {{ historyItems.length }} 张
        <template v-if="conflictCount"> · {{ conflictCount }} 张冲突</template>
        <em>展开</em>
      </span>
    </summary>

    <div class="income-history-list">
      <article
        v-for="item in historyItems"
        :key="item.id"
        class="income-history-card"
        :class="statusTone(item)"
        :data-income-id="item.id"
        :data-status="statusTone(item).replace('is-', '')"
      >
        <div class="income-history-thumb">
          <a
            v-if="item.image_url"
            :href="item.image_url"
            target="_blank"
            rel="noreferrer"
            :aria-label="`查看收益截图原图：${item.original_name || item.id}`"
          >
            <img
              :src="item.image_url"
              :alt="item.original_name || `收益截图 #${item.id}`"
              loading="lazy"
              decoding="async"
            />
          </a>
          <div v-else class="income-history-no-image">原图已清理</div>
          <a
            v-if="item.image_url"
            class="income-history-image-link"
            :href="item.image_url"
            target="_blank"
            rel="noreferrer"
          >
            查看原图
          </a>
        </div>

        <div class="income-history-body">
          <div class="income-history-head">
            <div>
              <strong>{{ item.original_name || `收益截图 #${item.id}` }}</strong>
              <span>收件 {{ formatDateTime(item.received_at) }}</span>
            </div>
            <em class="income-history-status">{{ statusLabel(item) }}</em>
          </div>

          <dl class="income-history-facts">
            <div>
              <dt>处理时间</dt>
              <dd>{{ formatDateTime(item.applied_at) }}</dd>
            </div>
            <div>
              <dt>关联收益日期</dt>
              <dd>{{ item.record_date || '—' }}</dd>
            </div>
            <div>
              <dt>产品代码</dt>
              <dd>
                <span v-if="!productCodes(item).length">未识别到产品明细</span>
                <span v-else class="income-history-products">
                  <RouterLink
                    v-for="code in productCodes(item)"
                    :key="`${item.id}-${code}`"
                    :to="{
                      name: 'r2-trades',
                      hash: '#valuations',
                      query: { product: code },
                    }"
                  >
                    {{ code }}
                  </RouterLink>
                </span>
              </dd>
            </div>
          </dl>

          <p v-if="noteText(item)" class="income-history-notes">
            {{ noteText(item) }}
          </p>

          <div class="income-history-actions">
            <RouterLink
              v-if="item.record_date"
              :to="{
                name: 'r2-daily',
                hash: '#records',
                query: { date: item.record_date },
              }"
            >
              查看当日账户收益
            </RouterLink>
            <RouterLink
              v-if="productCodes(item).length"
              :to="{
                name: 'r2-trades',
                hash: '#valuations',
                query: { product: productCodes(item)[0] },
              }"
            >
              查看逐产品收益档案
            </RouterLink>
          </div>
        </div>
      </article>
    </div>
  </details>
</template>
