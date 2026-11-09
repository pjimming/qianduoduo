import { chromium } from 'playwright-core'

const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const base = 'http://127.0.0.1:8765'
const slugs = {
  baijiu: '/investment/research/' + encodeURIComponent('白酒板块-主题深度-2026-11-08'),
  battery: '/investment/research/' + encodeURIComponent('电池板块-主题深度-2026-11-08'),
  laojiao: '/investment/research/' + encodeURIComponent('泸州老窖-000568-个股深度-2026-11-08'),
}
for (const [k, p] of Object.entries(slugs)) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(base + p, { waitUntil: 'networkidle' })
  await page.waitForSelector('.rp-doc h1', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(800)
  await page.screenshot({ path: `shots/${k}-top.png` })
  const info = await page.evaluate(() => {
    const doc = document.querySelector('.rp-doc')
    if (!doc) return null
    const cs = getComputedStyle(doc)
    const h1 = doc.querySelector('h1')
    const h1cs = h1 ? getComputedStyle(h1) : null
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      background: cs.backgroundColor,
      color: cs.color,
      width: Math.round(doc.getBoundingClientRect().width),
      h1Font: h1cs && h1cs.fontFamily,
      h1Size: h1cs && h1cs.fontSize,
      h1Weight: h1cs && h1cs.fontWeight,
      toc: !!doc.querySelector('.toc, nav.toc'),
      docHeight: doc.scrollHeight,
    }
  })
  console.log(k, JSON.stringify(info))
  await page.close()
}
await browser.close()
