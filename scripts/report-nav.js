/* ============================================================================
 * report-nav.js — 通用报告导航（自动挂载）
 * ----------------------------------------------------------------------------
 * 用法：
 *   报告（report/*.html）：<script src="../scripts/report-nav.js" defer></script>
 *   首页（index.html）：  <script src="scripts/report-nav.js" defer></script>
 * 无需为每篇报告写导航内容。
 *
 * 新增报告后，只需重新生成下方清单（不要手工逐篇改报告）：
 *     pwsh -NoProfile -File .\scripts\update-nav.ps1
 *
 * 设计约束：
 *   1) 清单内嵌在本文件，不使用 fetch，因此 file:// 直接双击打开也能工作；
 *   2) 只依赖 <script src> 经典脚本加载，不用 ES module（file:// 下模块会被 CORS 拦）；
 *   3) 样式自带前缀 rpnav-，并显式覆盖字体/下划线，避免被各报告自身 CSS 影响。
 * ==========================================================================*/
(function () {
  "use strict";

  /* 由 update-nav.ps1 自动生成 —— 请勿手工编辑此区块 */
  var REPORTS = [
    //>NAV:BEGIN
    { f: "A股机器人产业链-公司全景与阵型-2026-10-27.html", t: "A股机器人产业链（107家公司全景与阵型）｜行业调研", d: "2026-10-27", p: "2026-10-28 01:12", g: "机器人", s: "以107家A股公司全景重构机器人产业链：先区分整机、人形总成、传动执行、运控、感知、集成、物流、服务和材料电子，再按规模兑现、小批定点、导入验证和边缘映射分层；行业已经出现真实收入，但利润兑现仍集中在少数公司。", k: "机器人 人形机器人 具身智能 工业机器人 协作机器人 AGV AMR 减速器 谐波减速器 RV减速器 行星滚柱丝杠 执行器 伺服 运动控制 灵巧手 六维力 3D视觉 688836 300124 002979 002472 688017 002747 688306 002048 300607 300532" },
    { f: "浙江荣泰-603119-个股深度-2026-10-26.html", t: "浙江荣泰（603119）｜个股深度", d: "2026-10-26", p: "2026-10-28 01:12", g: "汽车安全材料", s: "新能源汽车热防护已贡献77.67%收入并支撑量产现金流，机器人精密件已完成小规模交付；但10月低位五日反弹36.14%、TTM PE升至87.98倍，市场正把尚无法单列的第二曲线定价进成熟主业。", k: "603119,浙江荣泰,云母材料,云母制品,新能源汽车,热失控防护,电池安全,绝缘材料,精密结构件,滚珠丝杠,行星滚柱丝杠,机器人零部件,人形机器人,上海狄兹,金力传动,泰国工厂,墨西哥工厂" },
    { f: "A股AI应用与AI软件板块-主题深度-2026-10-26.html", t: "A股AI应用与AI软件板块（主题组合）｜行业全景与核心公司调研", d: "2026-10-26", p: "2026-10-28 01:12", g: "AI应用与软件", s: "覆盖38只A股、11个子行业的全景调研：AI收入已开始被部分公司量化，但利润和现金流没有同步兑现；首轮深度研究扩到8家，避免用五家核心样本代替行业。", k: "AI应用 AI软件 人工智能 智能体 Agent 工业AI 财税AI 外贸AI 办公软件 金融信息服务 数据库 AI安全 端侧AI 002230 002315 002362 002439 300033 300058 300170 300229 300253 300348 300378 300418 300451 300454 300496 300624 300634 300674 300687 300766 600570 600588 600845 601360 603138 603171 603859 688023 688031 688039 688088 688095 688111 688561 688615 688692 688777 688787" },
    { f: "斯菱智驱-301550-个股深度-2026-10-25.html", t: "斯菱智驱（301550）｜个股深度", d: "2026-10-25", p: "2026-10-28 01:12", g: "机器人零部件", s: "谐波减速器与减速器专用轴承已经投产，但机器人收入仍低且客户、订单、单价未披露；2026H1主业增收减利，现价却对应约271倍TTM PE，市场正在提前定价尚未量化的第二曲线。", k: "301550,斯菱智驱,斯菱股份,汽车轴承,轮毂轴承,谐波减速器,减速器专用轴承,执行器模组,人形机器人,机器人零部件,浙江新昌,泰国工厂" },
    { f: "福赛科技-301529-个股深度-2026-10-23.html", t: "福赛科技（301529）｜个股深度", d: "2026-10-23", p: "2026-10-28 01:12", g: "汽车零部件", s: "2026H1收入持平、扣非净利仅增7.1%，机器人零部件仍无正式订单；158.4元现价对应约132倍TTM PE，市场定价已接近“机器人业务必须成功”的期权而非已实现利润。", k: "301529,福赛科技,汽车内饰,功能件,装饰件,新能源三电嵌件,机器人零部件,墨西哥,泰国,汽车零部件" },
    { f: "迈瑞医疗-300760-个股深度-2026-10-23.html", t: "迈瑞医疗（300760）｜个股深度", d: "2026-10-23", p: "2026-10-28 01:12", g: "医疗器械", s: "收入拐点已现、利润拐点未确认；现价已计入海外增长与国内修复，组合质量优秀但安全边际有限。", k: "300760,迈瑞医疗,IVD,体外诊断,生命信息与支持,医学影像,微创介入,医疗器械,海外增长" },
    { f: "鼎捷数智-300378-个股深度-2026-10-21.html", t: "鼎捷数智（300378）｜个股深度", d: "2026-10-21", p: "2026-10-28 01:12", g: "工业软件", s: "AI签约和工业数据闭环已形成中等强度证据，但利润被一次性收益放大、研发资本化和应收账款削弱可信度；38.36元已接近牛情景价值，当前更适合等待Q3经营验证。", k: "鼎捷数智 300378 工业软件 ERP MES PLM 雅典娜 EIOSpace AI 智能体 半导体 数智化" },
    { f: "光智科技-300489-个股深度-2026-10-20.html", t: "光智科技（300489）｜个股深度", d: "2026-10-20", p: "2026-10-28 01:12", g: "半导体材料", s: "现价已把红外探测器拐点、6 英寸磷化铟放量和锗资源化同时折现；但新增业务尚未形成报表利润，综合价值区间仅 20–140 元，现价 241 元对应显著高估。", k: "300489 光智科技 磷化铟 InP 锗 红外探测器" },
    { f: "华丰股份-605100-个股深度-2026-10-20.html", t: "华丰股份（605100）｜个股深度", d: "2026-10-20", p: "2026-10-28 01:12", g: "AI电源/机械", s: "首个AIDC柴发项目已交付，但公开可核验的相关收入仍来自20%参股方；在独立客户订单、海外认证和主用电源收入尚未验证前，现价对长期增长定价过满。", k: "605100 华丰动力 数据中心 柴油发电机组 燃气轮机 SOFC 重卡零部件 潍柴动力" },
    { f: "A股场内软件ETF-横向比较与底层资产调研-2026-10-20.html", t: "A股场内软件ETF（主题组合）｜ETF横向比较与底层资产调研", d: "2026-10-20", p: "2026-10-28 01:12", g: "软件ETF", s: "A股软件ETF已从高位回撤逾四成，估值分位回落但绝对盈利估值仍高；产品工具优先研究515230，证券动作暂以观望为主，低费率小规模产品不因费率低而入选。", k: "软件ETF 515230 159852 562930 561010 159068 159590 159899 560360 560790 159035 159036 159180 930601 H30202 932094" },
    { f: "A股AI应用板块-主题与核心公司深度调研-2026-10-20.html", t: "A股AI应用板块（主题组合）｜产业链与核心公司深度调研", d: "2026-10-20", p: "2026-10-28 01:12", g: "AI应用", s: "AI应用已从“接入模型”进入“证明收入与续费”的阶段；研究首选同花顺、焦点科技、金山办公，但当前只有同花顺落在合理区间上沿，金山办公已接近乐观情景定价。", k: "AI应用 人工智能 办公软件 金融信息服务 外贸B2B 智能体 688111 300033 002315 002230" },
    { f: "国防军工-板块调研-2026-10-16.html", t: "国防军工板块调研报告", d: "2026-10-16", p: "2026-10-28 01:12", g: "军工国防", s: "26H1 板块利润 +20.98%，指数却较 1 月峰值低 37%——本轮该先研究“利润已兑现的上游/总体”，而不是“卡点位置最硬的整机”", k: "高德红外002414 / 图南股份300855 / 中国船舶600150 / 睿创微纳688002 / 中航沈飞600760 / 航发动力600893 / 营业收入 / 归母净利润 / 毛利率 / 净利率 / 经营性净现金流 / 应收账款 / 存货 / 合同负债 / 研发费用 / 地面兵装 / 船舶 / 航空发动机 / 导弹 / 国防信息化 / 火箭卫星 / 航空（主机） / 中国船舶 / 图南股份 / 睿创微纳 / 航发动力 / 中航光电 / 高德红外 / 中航沈飞 / 中航西飞 / 中航成飞 / 洪都航空 / 中无人机 / 中国动力 / 紫光国微 / 中航高科 / 西部超导 / 光启技术 / 振华科技 / 应流股份 / 中国卫通 / 国博电子 / 中科星图 / 要查的东西 / 2026 年三季报重点：沈飞 / 成飞 / 睿创微纳单季增速是否延续 / 十五五首批规模化订单的公开线索中航工业 / 中国航发 / 兵器集团的相关公告；公司投资者关系记录（互动易 / 上证 e 互动）；军品订货会信息；招标与中标公告 / 珠海。重点看：首次亮相型号 / 是否有出口签约或意向协议 / 分行业数据；投资者关系记录；燃机客户（东方电气 / 上海电气等）的采购口径 / 需求与系统变化：钱从哪来，方向在哪 / 预算：稳健而非加速 / 十五五规划纲要：方向很明确，但同时写进了“低成本” / 订单节奏：这是全板块真正的“总闸门” / 三条增长曲线（卖方框架，仅作分层参考） / 产业链分层与卡点排序 / H1 报表全景：分化到什么程度 / 板块总量（卖方汇总，164 家重点公司） / 分环节：谁在修复，谁在恶化 / 前瞻指标：合同负债才是照妖镜 / 核心个股 26H1 业绩与估值 / 反驳一：军贸爆发的叙事，尚未出现在数据里 / 反驳二：估值已经先于业绩走完了一段，而前瞻指标还在恶化 / 反驳三：政策同时写入了“低成本”，这对供应方是毛利压力 / 交易面补充：今天的上涨本身也是一个反向信号 / 时间与口径 / 未解决的缺口（明确列出，不用假设填补）" },
    { f: "军工A股-地面兵装-航空装备-船舶舰艇-深度调研-2026-10-16.html", t: "军工A股深度调研：地面兵装 · 航空装备 · 船舶舰艇", d: "2026-10-16", p: "2026-10-28 01:12", g: "军工国防", s: "三个子板块的 26H1 报表指向同一个结论：卡点最硬的地方利润最弱，利润兑现最好的地方不是卡点；而\"军贸爆发\"在多数公司的海外收入科目里是负增长", k: "中国船舶600150 / 图南股份300855 / 高德红外002414 / 中航沈飞600760 / 中航光电002179 / 中兵红箭000519 / 内蒙一机600967 / 航发动力600893 / 营业收入 / 归母净利润 / 毛利率 / 净利率 / 经营性净现金流 / 应收账款 / 存货 / 合同负债 / 地面兵装 / 船舶 / 航空发动机 / 导弹 / 国防信息化 / 火箭卫星 / 航空（主机） / 需求驱动 / 真正的约束 / 客户替代选择 / 26H1 实际状态 / 能否转为股东利润 / 当前估值 / 中兵红箭 / 甘化科工 / 晋西车轴 / 光电股份 / 内蒙一机 / 北方导航 / 长城军工 / 天秦装备 / 北方长龙 / 2023 年报 / 2024 年报 / 2025 年报 / 2026H1 / 2024H1 / 2025H1 / 包头北方创业（铁路车辆） / 山西北方机械 / 路通弹簧 / 2026-09-04 / 09-05 / 整机总装 / 中航沈飞 600760 / 中航西飞 000768 / 中直股份 600038 / 动力系统 / 机载与信息化 / 中航光电 002179 / 航发控制 000738 / 材料与零部件 / 预算：稳健而非加速 / 十五五规划纲要：方向放在\"新域新质\"，同时写进了\"低成本\" / 订单节奏与事件窗口 / 板块总量（卖方汇总口径） / 卖方分环节增速（本报告对其中的\"地面兵装\"提出明确保留） / 三个板块的\"系统变化\"与约束差异 / 地面兵装：名义增速最快，个股最弱 / 一个必须首先澄清的口径问题 / 地面兵装真正的变化：竞争格局从封闭走向开放 / 这一环节该看什么 / 内蒙一机深度案例：唯一陆装总装平台的三年利润下行 / 位置与角色 / 财务：连续多个报告期的利润下行 / 决定性的一项：海外（军贸）收入同比 −92% / 军品信息豁免：这家公司的核心变量不可验证 / 可用的替代信号：两个正面、一个反面 / 民品：铁路货车是唯一明确的边际改善 / 2026 年 9 月的上涨：市场买的是\"大额订单\"，公告披露的是铁路货车 / 估值与目标缺口 / 航空装备：卡点最硬，利润最弱 / 航空装备 26H1 全景：三层分化 / 前瞻指标：合同负债是照妖镜 / 航空的两个具体判断 / 船舶舰艇：订单簿最实，但不是纯军工 / 行业数据：这一轮是真周期 / 船舶舰艇 26H1 全景 / 中国船舶：本报告在三板块中标出的最高优先级 / 船舶板块内值得注意的三点 / 跨板块关键检验：谁真有海外（军贸）收入 / 与之对照的第三方数据 / 估值全景与三板块对比 / 反驳一：市场定价的方向与本报告的判断正好相反——而市场可能是对的 / 反驳二：26H1 是\"订单空窗期\"的产物，用半年报判断全年可能是错的 / 反驳三：军贸数据的\"缺口\"可能只是披露问题，而非业务不存在 / 反驳四：政策同时写入了\"低成本\"，这对所有供应方都是长期压制 / 交易面补充：今日上涨本身也是反向信号 / 时间与口径 / 未解决的缺口（明确列出，不用假设填补）" },
    { f: "AI短剧-合规IP与内容资产层深度调研-2026-10-16.html", t: "AI短剧产业链｜“合规可确权的IP与内容资产”层深度调研", d: "2026-10-16", p: "2026-10-28 01:12", g: "AI/传媒", s: "这一层是真卡点，但A股构成失真：有生意的公司被冷落（视觉中国 近60日 -5.76%），有存货的公司被当成有生意买（新华文轩 +111.93%、新经典 +64.31%）", k: "子层 / A1 多模态视觉数据 / A2 文字 IP 与网文库 / A3 影视版权库 / A4 动画与动漫 IP / A5 出版与图书著作权 / A6 语料库与数据要素 / B 确权/存证/监测/标识 / 港股对照 / 市场叙事 / 监管收紧、侵权成本上升，利好正版 IP 方 / “AI 生成的内容无法确权、不受保护” / “有 IP 储备就有产业链定价权” / “华策影视、芒果超媒是 IP 层核心受益标的” / “果麦文化 / 读客文化 / 新华传媒等是 AI 短剧 IP 标的” / “IP 资产正在被重估” / “AI 数据授权已是视觉中国的新增长曲线” / 新华文轩（601811） / 中国科传（601858） / 凤凰传媒（601928） / 浙版传媒（601921） / 皖新传媒（601801） / 中文传媒（600373） / 长江传媒（600757） / 时代出版（600551） / 中国出版（601949） / 城市传媒（600229） / 中信出版（300788） / 新华传媒（600825） / 华媒控股（000607） / 读者传媒（603999） / 新经典（603096） / 果麦文化（301052） / 读客文化（301025） / 03738.HK / 查什么 / 视觉中国的数据授权业务是否已形成收入规模 / 中文在线 AI 数据业务的收入口径 / 上海电影 IP 授权的持续性 / 中信出版 IP 运营的持续性 / 奥飞娱乐 IP 授权收入能否单列 / 确权层是否拿到政策订单 / 出版公司的资产是否真的被货币化 / AI 训练数据授权的行业价格与规模 / 捷成股份的业绩锚与“灵犀”口径 / 新华传媒重组的进展与定价 / 行业层面的确权判例与平台机制 / 一、合规确权框架：从灰色地带到“一横一纵” / 纵向（司法确权） / 横向（监管治理） / 二、这一层为什么是真卡点 / 需求侧：合规从“加分项”变成“入场券” / 政策侧：三项制度同时指向“可确权” / 供给侧：合规性无法速成，这是它成为卡点的原因 / 三条变现路径（判断公司时必须区分） / 三、子层划分与优先级 / 四、叙事检验表 / 🥇 高优先级 / 🥈 中优先级 / 🔍 观察 / ❌ 低优先级／需剔除：出版与传媒集团群 / 📐 港股对照：这门生意的真实量级 / 六、最强反证 / 七、图表速览 / 八、行情与估值对照（2026-10-15 收盘） / 上一轮（2026-10-15）覆盖的其他 IP 层标的" },
    { f: "AI短剧产业链-A股调研-2026-10-15.html", t: "A股 AI短剧 / AI漫剧 产业链调研", d: "2026-10-15", p: "2026-10-28 01:12", g: "AI/传媒", s: "瓶颈已不在“谁能生成”——视频模型正在变成水电煤式的公共品；A股真正可研究的两个卡点是海外分发与买量效率、合规可确权的内容资产，内容产能已经过剩", k: "成本口径 / 海外单部制作成本 / 成片周期 / 精品 AI 仿真人短剧（2026Q1） / 模型调用价格 / 算力 / 视频模型 / 生产工具 / Agent / IP / 合规内容资产 / 分发平台 / 投流 / 营销 / 内容制作（承制/代工） / 市场叙事 / “AI 短剧是 2026 年传媒最强主线 / 市场规模爆发” / “AI 降本 90%，做短剧的都能赚钱” / “昆仑万维是 AI 短剧商业化兑现龙头” / “中文在线海外短剧进入盈利时代” / “掌阅/万兴/捷成是 AI 短剧核心受益标的” / “慈文传媒、欢瑞世纪等是 AI 漫剧龙头” / “出版与图书公司是 AI 语料/IP 标的” / 慈文传媒002343 / 欢瑞世纪000892 / 新经典603096 / 果麦文化301052 / 德才股份605287 / 吉视传媒601929 / 易点天下／蓝色光标／因赛集团 / 富春股份／电魂网络／完美世界等 / 查什么 / AI 短剧分部能否持续盈利 / 中文在线短剧业务的利润质量 / 掌阅科技减亏是否可持续 / 工具层是否形成可单列收入 / 捷成股份的内容资产与业绩锚 / 南威软件海外发行 APP 的实际落地 / 海看股份微短剧是否进入披露门槛 / 合规成本对行业的影响 / 平台侧供给结构变化 / 一、这次变化到底是什么 / 需求端：短剧从“付费小程序”变成“免费的国民时长” / 技术端：内容生产的边际成本被重估 / 供给端：产能已经过剩，行业进入“减量提质” / 政策端：合规成为新的稀缺性来源 / 二、产业链分层与真正的“卡点” / 三、叙事检验表 / 🥇 高优先级 / 🥈 中优先级 / 🔍 观察：有实质动作，但财务映射不清晰 / ❌ 低优先级／概念待验证 / 五、图表速览 / 六、行情与估值对照（2026-10-15 收盘）" },
    { f: "行云科技-300209-调研备忘-2026-10-14.html", t: "行云科技（300209.SZ）调研备忘", d: "2026-10-14", p: "2026-10-28 01:12", g: "AI算力", s: "2025 年底才完成破产重整的跨境电商壳，半年内跨界算力租赁；9 亿净资产对应 200 亿采购预算、实控人股份 100% 被轮候冻结，PB 约 35 倍", k: "市场叙事 / 破产重整+算力转型，业绩爆发 / 160 亿在手算力订单 / 服务器销售毛利率 98% 的暴利生意 / \"Token 第一股\"/TaaS 模式 / AI 供应链瓶颈受益者 / 实控人浮盈 14 倍的\"产业投资人\" / 历史治理记录 / 要判断的事 / 算力业务真实利润 / 订单转化能力 / 客户身份 / 200 亿采购资金来源 / 实控人风险 / Q3 利润构成 / 估值锚 / 一、叙事检验表 / 二、图表速览 / 三、产业链与公司位置（Serenity 框架） / 五、从业务到利润" },
    { f: "四会富仕-300852-调研备忘-2026-10-13.html", t: "四会富仕（300852.SZ）调研备忘", d: "2026-10-13", p: "2026-10-28 01:12", g: "电子材料", s: "工控/汽车/通信基本盘真实高增（H1 营收 +43.4%），但光模块 PCB 收入占比不足 1%、基材全部外购；一年 +74% 后，买的是 2027 年的四会富仕", k: "市场叙事 / 800G 光模块 PCB 已放量 / 1.6T 光模块 PCB 进入供应链 / RCC（无玻纤）高密度板替代 ABF / CPO / 光模块新贵 / AI 服务器 PCB 核心供应商 / 基本盘（工控/汽车/通信）真实增长 / 人形机器人 PCB 批量供货 / 2026H1 盈利质量隐忧 / 要判断的事 / 800G 光模块 PCB 阶段 / 1.6T 光模块 PCB 阶段 / 光模块 PCB 体量 / RCC 进度与材料 / 2026H1 业绩 / 毛利率轨迹 / 现金流与费用 / 定增进展 / 股权激励 / 扩产纪律 / 一、叙事检验表 / 二、图表速览 / 三、产业链与公司位置（Serenity 框架） / 五、从业务到利润" },
    { f: "金安国纪-覆铜板产业链调研-2026-09-29.html", t: "金安国纪（002636）覆铜板产业链调研", d: "2026-09-29", p: "2026-10-28 01:12", g: "电子材料", s: "研究优先级：中等偏上（周期性高弹性标的，非 AI 卡点标的）。 我会把金安国纪放在“覆铜板涨价周期 + 自产电子布”这条线上继续研究，而不是放在“AI 算力供应链”这条线上。", k: "产业链分层 / 特种/低介电电子布、电子纱 / 高速/高频覆铜板 / 通用覆铜板（金安国纪所在层） / 铜箔 / 合成树脂 / 要判断的事 / 卖的是什么 / 是否有 AI 敞口 / 高频高速进展 / 收入与利润 / 盈利能力 / 产能与产量 / 成本与供应链 / 现金与质量 / 非经常性因素 / 覆铜板销量（万张） / 覆铜板均价（元/张） / 覆铜板收入（亿元） / 覆铜板毛利率 / 归母净利润（亿元） / 可比公司 / 金安国纪（002636） / 生益科技（600183） / 南亚新材（688519） / 华正新材（603186） / 建滔积层板（1888.HK） / 宏和科技（电子布，603256） / 中材科技（002080，特种布） / 待查事项 / 价格与毛利率的持续性 / 融资摊薄 / 产能落地 / 高频高速商业化 / 上游瓶颈是否缓解 / 下游承接能力 / 公司自身对比基准 / 目前最影响判断的缺口 / 二、产业链地图：AI 把压力加在了哪一节 / 四、从量价到利润 / ）价格是这条业绩曲线的全部解释 / ）估值与股价路径 / ）两笔扩产：都在周期后段才交货 / 反面：什么会提高优先级" },
    { f: "博硕科技-300951-调研备忘-2026-09-24.html", t: "博硕科技（300951.SZ）调研备忘", d: "2026-09-24", p: "2026-10-28 01:12", g: "消费电子", s: "半年报白纸黑字写明 AI 服务器装备报告期内尚无收入，股价年内却涨约 1.7 倍；主业苹果链功能件由盈转亏，大股东同期减持 1.56%", k: "市场叙事 / 切入英伟达 AI 服务器自动化设备供应链 / 液冷/组装设备订单逐步落地 / 主业受益苹果份额提升、稳健增长 / 2026H1 由盈转亏 / 股东高位减持 / 要判断的事 / AI 服务器装备有无收入 / 新业务方向 / 主业盈利质量 / 亏损性质 / 盛传的订单细节（270 条产线 / 2000 万液冷 / 泰瑞达合作） / 股东行为 / 一、叙事检验表 / 二、图表速览 / 三、产业链与公司位置（Serenity 框架） / 五、从业务到利润" },
    { f: "远东股份-600869-调研备忘-2026-09-22.html", t: "远东股份（600869.SH）调研备忘", d: "2026-09-22", p: "2026-10-28 01:12", g: "电力设备", s: "光棒产能爬坡与 CSP 客户认证是真实进展，但 AI 相关收入占比仅约 6%、承载叙事的板块仍在亏损；80% 资产负债率与大额担保是主要短板", k: "市场叙事 / AI 全光互连业务爆发 / 光棒产能大幅扩产 / 液冷第二曲线 / 订单充足支撑增长 / 业绩高增验证成长 / 财务风险可控 / 一、叙事检验表 / 二、图表速览 / 三、产业链位置：瓶颈在哪里，公司卡在哪里" },
    { f: "航发动力-洪都航空-对比调研-2026-09-21.html", t: "航发动力 vs 洪都航空 · 供应链瓶颈对比调研", d: "2026-09-21", p: "2026-10-28 01:12", g: "军工国防", s: "这两家公司都不能算“卡点上的公司”，它们是卡点下游的总装集成平台。2026 年上半年，航发动力收入 207.55 亿元（同比 +47.21%）、归母净利 1.46 亿元（净利率 0.70%）；…", k: "2026H1 营业收入 / 2026H1 归母净利 / 2026H1 扣非归母 / 2026H1 毛利率 / 2026H1 净利率 / 2026H1 经营现金流 / 应收账款 / 存货 / 合同负债（较年初） / 有息负债 / 归母净资产 / 总资产 / 加权平均 ROE（半年） / 指标（FY2025） / 营业收入 / 归母净利 / 扣非归母 / 经营现金流 / 加权平均 ROE / 分产品收入与毛利率 / 前瞻指标 / 2026 年日常关联交易·销售计划 / 2026 年日常关联交易·采购计划 / 2026H1 合同负债变化 / 公司公开表述 / 项目（2026-09-18 收盘） / 收盘价 / 总股本 / 总市值 / PE（TTM，归母） / PB / FY2025 现金分红对应股息率 / 2026 年内涨跌（前复权） / 2026 年内高 / 低点 / 反方理由 / 航发动力的“资产价值”是重资产而非高效资产 / 航发动力毛利率仍在被“新产品成熟度”吞噬 / 洪都航空的高增长不等于高盈利 / 洪都航空的客户与关联结构高度集中 / 两家的股东回报都极低 / 一、同口径对比：2026H1 与 FY2025 / 二、卡点排查：约束在它们的上游，不在它们身上 / 三、订单前瞻：谁在真的往上走 / 四、估值与预期：价格里已经装了什么" },
    { f: "富乐德-产业链调研-2026-09-20.html", t: "富乐德（301297.SZ）供应链瓶颈调研", d: "2026-09-20", p: "2026-10-28 01:12", g: "半导体设备", s: "服务赚钱、材料讲故事：洗净/再生以 38.6% 的收入贡献约 56% 的毛利，而 9 月行情定价的 DPC 仅占收入 6%；67.7 倍 TTM PE 与 42.68% 的业绩承诺完成率是两个硬约束", k: "产品／服务 / 精密洗净 / DCB（氧化铝等覆铜陶瓷载板） / AMB（氮化硅活性金属钎焊载板） / DPC（直接镀铜陶瓷载板） / 要判断的事 / 公司实际卖什么 / DPC 是否真有 AI 光模块需求 / 产能扩张能否支撑放量 / 光模块陶瓷基板的大市场空间 / 传统载板业务是否稳健（DCB/AMB） / 洗净业务的产能是否真的紧张 / 收购资产的成色 / 2025 年全年 / 2026 年上半年 / 收盘价 / 总股本 / 总市值 / PE（TTM，归母） / PE（TTM，扣非） / PB / 加权平均 ROE / 资产负债率 / 52 周区间 / 反方理由 / 最赚钱业务的“卡点”属性并不唯一，扩产会稀释回报 / DPC 的高增速可能只是小基数效应 / 陶瓷载板的“AI 电源卡点”叙事被分部数据反驳 / 估值已把完美执行计入价格 / 治理与利益一致性 / 题材高贝塔：持仓体验由板块流动性决定 / 竞争格局未定：DPC 并非富乐华独占环节 / 一、先看现金流与盈利质量，再看故事 / 分产品数据：故事与现实的分叉 / 二、公司是怎么变成今天这样的（前提事实与治理） / 三、系统变化与卡点排查 / 卡点一：半导体设备与零部件的交期（对洗净/再生最有利） / 卡点二：光模块温控用 DPC 基板（增速最快，但披露最薄） / 卡点三：SiC 用 AMB 氮化硅基板——这个卡点目前是被数据反驳的 / 五、从业务到利润：必须盯住的分部数字 / ）洗净：量在增、毛利稳，但资本开支也在膨胀 / ）陶瓷载板：价格与原料两头挤压 / ）子公司口径与承诺完成压力 / 六、估值与筹码：当前价格假设了什么 / 筹码结构：2026 年 7 月是一次典型的“解禁+回调” / 七、图表速览" },
    { f: "杭电股份-603618-调研备忘-2026-09-20.html", t: "杭电股份（603618.SH）调研备忘", d: "2026-09-20", p: "2026-10-28 01:12", g: "电力设备", s: "基本面反转是真实的（H1 归母 +938.67%），但光通信以不足一成收入撑起全部利润，AI 高端铜箔仍在亏损，实控人高位套现 6.24 亿元", k: "叙事主张 / 光纤量价齐升、满产 / \"AI 高端铜箔\"受益 / 电缆基本盘稳 / 机器人电缆/算力电缆 / 一、逐条检验市场叙事 / 二、图表速览 / 三、三个必须记住的事实 / . 反转来源单一且周期属性强 / . 现金流与利润背离 / . 实控人在高位兑现" },
    { f: "天通股份-600330-调研备忘-2026-09-20.html", t: "天通股份（600330.SH）调研备忘", d: "2026-09-20", p: "2026-10-28 01:12", g: "电子材料", s: "铌酸锂晶圆的上游位置属实（8 英寸光学级已量产），但公司自行澄清产能与销量均不大、募投延期至 2029 年，362 亿市值定价的是三年后的薄膜铌酸锂", k: "收盘价 / 总市值 / 近两年股价区间 / 2025 营收 / 归母净利 / 2026H1 营收 / 归母净利 / 2026H1 减值合计 / 2025 毛利率 / 资产负债率 / 货币资金 / 应收账款 / 存货 / 机构预测（中航证券 2026-06-05） / 市场叙事 / \"薄膜铌酸锂（TFLN）调制器上游核心材料商 / 谁做器件都要买它的料\" / \"铌酸锂业务即将放量 / 2026 是从 1 到 10 的元年\" / \"公司涉足光模块 / 商业航天\" / \"磁性材料受益 AI 算力 / 芯片电感切入 AI 服务器电源\" / \"蓝宝石盈利修复\" / \"光伏装备出清后利润端改善\" / \"筹划 H 股上市 = 国际化利好\" / 关键指标卡 / 叙事检验表 / 图表速览 / 供应链分析 / 一、系统变化：AI 光互联升级与\"光进铜退\" / 二、供应链位置与可替代性 / 三、公司敞口：材料真实增长，装备真实失血 / 四、盈利兑现与财务质量 / 五、估值与预期 / 六、反方论证（什么会让优先级下降） / 核心事实（已核验） / 来源" },
    { f: "A股场内纳斯达克100ETF-横向比较与底层资产调研-2026-10-21.html", t: "A股场内纳斯达克100 ETF（同指数产品组）｜ETF横向比较与底层资产调研", d: "2026-10-21", p: "2026-10-21 00:45", g: "纳斯达克100 ETF", s: "12只直接跟踪纳斯达克100的场内QDII ETF在10月20日收盘价较IOPV溢价约10.0%–18.0%，多数于10月21日发布溢价风险提示或早盘停牌；当前不应追价，159632、513390、159513仅在溢价显著收敛后具备继续研究价值。", k: "纳斯达克100 ETF 纳指ETF 513100 159941 513110 513300 513390 513870 159501 159513 159632 159659 159660 159696 NDX QQQ QDII" },
    //>NAV:END
  ];
  /* /自动生成区块 */

  /* 清单生成时间（同样由 update-nav.ps1 写入） */
  var NAV_META = {
    //>META:BEGIN
    generated: "2026-10-28 01:19"
    //>META:END
  };

  /* 报告统一位于工作区 report/ 目录。以本脚本位置反推工作区，确保首页和
   * report/ 内的报告都能生成正确链接，兼容 file:// 直接打开。 */
  var REPORTS_BASE = "report/";
  try {
    if (document.currentScript && document.currentScript.src) {
      REPORTS_BASE = new URL("../report/", document.currentScript.src).href;
    }
  } catch (e) { /* 保留相对路径回退 */ }

  function reportHref(file) {
    try {
      return new URL(String(file || ""), REPORTS_BASE).href;
    } catch (e) {
      return String(file || "");
    }
  }

  /* 对外暴露清单：首页 index.html 直接复用，避免出现第二份报告列表 */
  try {
    window.REPORT_NAV_DATA = {
      version: 1,
      generated: NAV_META.generated,
      reports: REPORTS.slice(),
      hrefFor: reportHref
    };
  } catch (e) { /* 忽略 */ }

  var ROOT_ID = "rpnav-root";
  var CSS_ID = "rpnav-style";
  var STORAGE_KEY = "rpnav:collapsed";

  function basename(p) {
    var s = String(p || "");
    try { s = decodeURIComponent(s); } catch (e) { /* 保持原串 */ }
    s = s.split("?")[0].split("#")[0];
    var parts = s.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var CURRENT = basename(window.location.pathname);
  var CURRENT_ENCODED = "";
  try { CURRENT_ENCODED = encodeURI(CURRENT); } catch (e) { CURRENT_ENCODED = CURRENT; }

  function isCurrent(file) {
    if (!file) return false;
    var b = basename(file);
    if (b === CURRENT) return true;
    try { return encodeURI(b) === CURRENT_ENCODED; } catch (e) { return false; }
  }

  function sorted() {
    return REPORTS.slice().sort(function (a, b) {
      var pa = String(a.p || ""), pb = String(b.p || "");
      if (pa !== pb) return pb.localeCompare(pa);          // 发布时间倒序
      var da = String(a.d || ""), db = String(b.d || "");
      if (da !== db) return db.localeCompare(da);          // 调研日期倒序
      return String(a.t || "").localeCompare(String(b.t || ""), "zh-Hans-CN");
    });
  }

  function injectStyle() {
    if (document.getElementById(CSS_ID)) return;
    var css = [
      "#" + ROOT_ID + "{position:fixed;right:18px;bottom:18px;z-index:2147483000;",
      "font-family:'PingFang SC','Microsoft YaHei','Hiragino Sans GB',-apple-system,'Segoe UI',sans-serif;",
      "font-size:14px;line-height:1.6;color:#141b26;text-align:left;}",
      "#" + ROOT_ID + " *{box-sizing:border-box;}",
      "#rpnav-btn{display:flex;align-items:center;gap:8px;border:1px solid #1b3a5c;border-radius:999px;",
      "background:#1b3a5c;color:#fff;padding:10px 16px;font-size:13.5px;font-weight:700;cursor:pointer;",
      "box-shadow:0 6px 20px rgba(16,35,55,.28);font-family:inherit;line-height:1;}",
      "#rpnav-btn:hover{background:#2a5480;border-color:#2a5480;}",
      "#rpnav-btn:focus-visible{outline:2px solid #b8860b;outline-offset:2px;}",
      ".rpnav-ico{font-size:15px;line-height:1;}",
      ".rpnav-cnt{background:rgba(255,255,255,.18);border-radius:999px;padding:1px 7px;font-size:12px;}",
      "#rpnav-panel{position:absolute;right:0;bottom:calc(100% + 10px);width:min(430px,calc(100vw - 36px));",
      "max-height:min(66vh,620px);display:flex;flex-direction:column;background:#fff;",
      "border:1px solid #dfe4ec;border-radius:10px;box-shadow:0 16px 44px rgba(16,35,55,.22);overflow:hidden;}",
      "#rpnav-panel[hidden]{display:none;}",
      ".rpnav-hd{padding:13px 15px 11px;border-bottom:1px solid #eef1f6;background:#f8fafc;}",
      ".rpnav-hd .rpnav-ttl{font-size:14px;font-weight:700;color:#1b3a5c;display:flex;",
      "justify-content:space-between;align-items:baseline;gap:10px;}",
      ".rpnav-hd .rpnav-sub{font-size:12px;color:#68768a;font-weight:400;}",
      "#rpnav-q{width:100%;margin-top:9px;padding:7px 10px;border:1px solid #dfe4ec;border-radius:6px;",
      "font-size:13px;font-family:inherit;color:#141b26;background:#fff;}",
      "#rpnav-q:focus{outline:none;border-color:#2a5480;box-shadow:0 0 0 3px rgba(42,84,128,.12);}",
      "#rpnav-list{overflow:auto;padding:7px;margin:0;list-style:none;}",
      ".rpnav-item{display:block;padding:9px 11px;border-radius:7px;text-decoration:none;",
      "border:1px solid transparent;color:#141b26;}",
      "a.rpnav-item:hover{background:#f2f6fb;border-color:#dbe5f0;}",
      ".rpnav-item .rpnav-t{display:block;font-size:13.5px;font-weight:600;color:#1b3a5c;",
      "text-decoration:none;word-break:break-word;}",
      ".rpnav-item .rpnav-m{display:block;margin-top:3px;font-size:12px;color:#68768a;",
      "font-variant-numeric:tabular-nums;}",
      ".rpnav-chip{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;",
      "background:#e7eef6;color:#2a5480;font-size:12px;font-weight:600;}",
      ".rpnav-item.rpnav-cur{background:#fff8e8;border-color:#f0dcb4;}",
      ".rpnav-item.rpnav-cur .rpnav-t{color:#8a5a10;}",
      ".rpnav-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;",
      "background:#b8860b;color:#fff;font-size:12px;font-weight:700;}",
      ".rpnav-empty{padding:16px 12px;color:#68768a;font-size:13px;text-align:center;}",
      ".rpnav-ft{padding:9px 14px;border-top:1px solid #eef1f6;background:#f8fafc;",
      "font-size:12px;color:#68768a;}",
      "@media (max-width:520px){#" + ROOT_ID + "{right:12px;bottom:12px;}",
      ".rpnav-txthide{display:none;}}"
    ].join("");
    var st = document.createElement("style");
    st.id = CSS_ID;
    st.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(st);
  }

  function renderList(ul, q) {
    var data = sorted();
    var query = String(q || "").trim().toLowerCase();
    if (query) {
      data = data.filter(function (r) {
        return (String(r.t || "") + " " + String(r.d || "") + " " + String(r.p || "") + " " + String(r.g || "") +
                " " + String(r.f || "")).toLowerCase().indexOf(query) >= 0;
      });
    }
    while (ul.firstChild) ul.removeChild(ul.firstChild);

    if (!data.length) {
      var li0 = document.createElement("li");
      li0.className = "rpnav-empty";
      li0.textContent = "没有匹配的报告";
      ul.appendChild(li0);
      return;
    }

    data.forEach(function (r) {
      var li = document.createElement("li");
      var cur = isCurrent(r.f);
      var el;

      if (cur) {
        el = document.createElement("div");
        el.className = "rpnav-item rpnav-cur";
      } else {
        el = document.createElement("a");
        el.className = "rpnav-item";
        el.setAttribute("href", reportHref(r.f));
      }

      var t = document.createElement("span");
      t.className = "rpnav-t";
      t.textContent = String(r.t || r.f || "(未命名报告)");
      el.appendChild(t);

      if (r.g) {
        var chip = document.createElement("span");
        chip.className = "rpnav-chip";
        chip.textContent = String(r.g);
        t.appendChild(chip);
      }
      if (cur) {
        var badge = document.createElement("span");
        badge.className = "rpnav-badge";
        badge.textContent = "当前";
        t.appendChild(badge);
      }

      var meta = document.createElement("span");
      meta.className = "rpnav-m";
      meta.textContent = (r.d ? String(r.d) : "日期未标注") +
        (cur ? "" : "　·　点击打开");
      el.appendChild(meta);

      li.appendChild(el);
      ul.appendChild(li);
    });
  }

  /* 首页自身就是完整清单，可用 <html data-rpnav-off> 关掉悬浮按钮 */
  function isSuppressed() {
    var de = document.documentElement, bd = document.body;
    return (!!de && de.hasAttribute("data-rpnav-off")) ||
           (!!bd && bd.hasAttribute("data-rpnav-off"));
  }

  function build() {
    if (document.getElementById(ROOT_ID)) return;
    if (!document.body) return;
    if (isSuppressed()) return;
    injectStyle();

    var root = document.createElement("div");
    root.id = ROOT_ID;

    var btn = document.createElement("button");
    btn.id = "rpnav-btn";
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "rpnav-panel");
    btn.setAttribute("title", "报告导航（按 Esc 关闭）");
    btn.innerHTML = '<span class="rpnav-ico">☰</span>' +
      '<span class="rpnav-txthide">报告导航</span>' +
      '<span class="rpnav-cnt">' + REPORTS.length + '</span>';

    var panel = document.createElement("div");
    panel.id = "rpnav-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "报告导航");
    panel.hidden = true;

    var hd = document.createElement("div");
    hd.className = "rpnav-hd";
    var ttl = document.createElement("div");
    ttl.className = "rpnav-ttl";
    var spanT = document.createElement("span");
    spanT.textContent = "全部调研报告";
    var spanS = document.createElement("span");
    spanS.className = "rpnav-sub";
    spanS.textContent = "共 " + REPORTS.length + " 篇";
    ttl.appendChild(spanT);
    ttl.appendChild(spanS);
    var q = document.createElement("input");
    q.id = "rpnav-q";
    q.type = "search";
    q.placeholder = "搜索标题 / 日期 / 标签…";
    q.setAttribute("autocomplete", "off");
    hd.appendChild(ttl);
    hd.appendChild(q);

    var ul = document.createElement("ul");
    ul.id = "rpnav-list";

    var ft = document.createElement("div");
    ft.className = "rpnav-ft";
    ft.textContent = "清单由 scripts/update-nav.ps1 自动生成；新增报告无需修改既有报告。";

    panel.appendChild(hd);
    panel.appendChild(ul);
    panel.appendChild(ft);
    root.appendChild(panel);
    root.appendChild(btn);
    document.body.appendChild(root);

    renderList(ul, "");

    function open(show) {
      panel.hidden = !show;
      btn.setAttribute("aria-expanded", show ? "true" : "false");
      if (show) {
        renderList(ul, q.value);
        q.focus();
        q.select();
      }
    }
    function toggle() { open(panel.hidden); }

    btn.addEventListener("click", function (e) { e.preventDefault(); toggle(); });
    // 面板内部点击不关闭；外部点击才关闭。
    // 用 root.contains 判断比 stopPropagation 更稳：不受事件派发顺序影响。
    panel.addEventListener("click", function (e) { e.stopPropagation(); });
    q.addEventListener("input", function () { renderList(ul, q.value); });
    q.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { open(false); btn.focus(); }
      if (e.key === "Enter") {
        var first = ul.querySelector("a.rpnav-item");
        if (first) window.location.href = first.getAttribute("href");
      }
    });
    document.addEventListener("click", function (e) {
      if (panel.hidden) return;
      if (e.target === btn || btn.contains(e.target)) return;
      if (root.contains(e.target)) return;
      open(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) { open(false); btn.focus(); }
      // 快捷键：g 打开导航（不在输入态时）
      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var tag = (e.target && e.target.tagName || "").toLowerCase();
        if (tag !== "input" && tag !== "textarea" && !e.target.isContentEditable) {
          e.preventDefault();
          open(true);
        }
      }
    });

    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") { /* 预留：可记忆折叠状态 */ }
    } catch (e) { /* file:// 或隐私模式下忽略 */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
