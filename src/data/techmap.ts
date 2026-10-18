import rawTechMap from './techmap.json'

export interface TechCompany {
  n: string
  c: string
}

export interface TechLeaf {
  name: string
  board: string
  cos: TechCompany[]
}

export interface TechSub {
  name: string
  leaves: TechLeaf[]
}

export interface TechGroup {
  id: string
  name: string
  desc: string
  subs: TechSub[]
}

export interface TechMapData {
  date: string
  colors: Record<string, string>
  groups: TechGroup[]
}

export interface TechMapStats {
  groups: number
  subs: number
  leaves: number
  companies: number
}

export interface HighlightPart {
  text: string
  match: boolean
}

export const techMap = rawTechMap as TechMapData

export const techMapStats: TechMapStats = {
  groups: techMap.groups.length,
  subs: techMap.groups.reduce((total, group) => total + group.subs.length, 0),
  leaves: techMap.groups.reduce(
    (total, group) =>
      total + group.subs.reduce((subTotal, sub) => subTotal + sub.leaves.length, 0),
    0,
  ),
  companies: new Set(
    techMap.groups.flatMap((group) =>
      group.subs.flatMap((sub) => sub.leaves.flatMap((leaf) => leaf.cos.map((company) => company.c))),
    ),
  ).size,
}

export const techMapGroupSources: Record<string, string> = {
  semi: '东财行业: 半导体(BK1036) / 电子(BK1201)',
  pcb: '东财行业: 元件(BK0459) / 其他电子(BK1336) / 电子化学品(BK1039)',
  comm: '东财行业: 通信(BK1215) / 通信设备(BK0448) / 通信服务(BK0736)',
  ai: '东财行业: 计算机(BK1207) / 软件开发(BK0737) / IT服务(BK1444)',
  power: '东财行业: 电力设备(BK1200) / 电池(BK1033) / 光伏设备(BK1031)',
  robot: '东财行业: 机械设备(BK1205) / 自动化设备(BK1237) / 通用设备(BK0545)',
  defense: '东财行业: 国防军工(BK1204) / 军工电子(BK1233) / 金属新材料(BK1288)',
  media: '东财行业: 传媒(BK0486) / 游戏(BK1046) / 数字媒体(BK1221)',
}

export const techMapChain: string[][] = [
  ['层级', '典型环节', '为什么值得单独看'],
  ['材料层', '电子布、特种树脂、HVLP铜箔、光刻胶、电子特气、靶材', '扩产最慢、认证最长，涨价弹性最大'],
  [
    '设备与零部件',
    '光刻机与零部件、量测检测、刻蚀薄膜、封装设备、PCB钻孔曝光',
    '从0到1，单台价值量高，国产化率最低',
  ],
  ['制造层', '晶圆代工、存储晶圆、先进封装产能、面板', '资本开支密集，是算力芯片的物理瓶颈'],
  ['器件与模组', '光模块、光芯片、MLCC、连接器、存储模组、电源', 'A股全球话语权最强的一段'],
  ['系统与整机', 'AI服务器、液冷、交换机、消费电子组装', '收入体量大，毛利率相对低'],
  ['软件与应用', '信创、工业软件、AI应用、数据要素、网络安全', '弹性来自订单与渗透率，不受产能限制'],
]

export const techMapNotes = [
  {
    label: '分类口径',
    text: '以东财行业分类（三级）为骨架，叠加市场概念板块（当日共 504 个概念板块）作为交叉校验；一个细分可能对应多个概念板块。',
  },
  {
    label: '公司选取',
    text: '按该板块真实成分股 + 市值排序筛选代表公司，共 750 家，括号内为证券代码，全部与 2026-09-16 的实时名称逐条核对过。',
  },
  {
    label: '重叠提醒',
    text: '概念板块是市场标签，同一家公司会同时出现在多个方向，按板块加总会重复计算，不能直接当作某方向的规模。',
  },
  {
    label: '不含范围',
    text: '港股与中概股、医药生物、券商地产等非科技行业；传媒只保留了一个泛科技分支。',
  },
  {
    label: '名称变更',
    text: '韦尔股份→豪威集团、博创科技→长芯博创、万业企业→先导基电、北京君正→君正股份、中电科网安→电科网安、长远锂科→五矿新能、华虹公司→华虹宏力；闻泰科技现为 *ST闻泰，东方通已退市，臻镭科技/佳缘科技/惠伦晶体/东尼电子/信安世纪带 ST，这类标的已从名单中剔除或改名。',
  },
]

export const techMapUsage = [
  '顶部搜索框可同时搜方向名和公司名；门类按钮可只看某一门类；Esc 清空搜索。打印时可另存为 PDF。',
  '先定位你熟悉的那家公司属于哪条链，再看它的上下游分别对应哪些方向，判断逻辑比记标签更稳。',
  '本图是产业地图与事实索引，不构成投资建议；涉及个股请以最新公告与定期报告为准。',
]

export function groupColor(group: TechGroup): string {
  return techMap.colors[group.id] ?? '#2f6fed'
}

export function groupLeafCount(group: TechGroup): number {
  return group.subs.reduce((total, sub) => total + sub.leaves.length, 0)
}

export function groupCompanyCount(group: TechGroup): number {
  return new Set(
    group.subs.flatMap((sub) => sub.leaves.flatMap((leaf) => leaf.cos.map((company) => company.c))),
  ).size
}

export function leafSearchText(group: TechGroup, sub: TechSub, leaf: TechLeaf): string {
  return [group.name, sub.name, leaf.name, leaf.board, ...leaf.cos.map((company) => company.n)]
    .join(' ')
    .toLowerCase()
}

export function highlightParts(text: string, term: string): HighlightPart[] {
  const needle = term.trim().toLowerCase()
  if (!needle) return [{ text, match: false }]

  const parts: HighlightPart[] = []
  const lower = text.toLowerCase()
  let cursor = 0

  while (cursor < text.length) {
    const index = lower.indexOf(needle, cursor)
    if (index === -1) {
      parts.push({ text: text.slice(cursor), match: false })
      break
    }
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false })
    parts.push({ text: text.slice(index, index + needle.length), match: true })
    cursor = index + needle.length
  }

  return parts.length ? parts : [{ text, match: false }]
}
