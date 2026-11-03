# 价格来源与计算边界

本插件按公开价目和 Harness 已报告的用量估算费用，不访问用户账单。价目与参考汇率会变化；每笔已计价记录保存首次计价时的来源、单价、规则和汇率。

## 模型价目

[OpenRouter 全模态 API](https://openrouter.ai/api/v1/models?output_modalities=all)提供所有输出类型；不带参数的默认列表仅包含文本输出模型。2026-11-03 随包快照共 685 个模型；代码跟随分页并校验 `total_count`，不会把缺页的列表当作完整价目。

价格字符串的单位是美元/Token。界面单价按每百万 Token 展示。有效的 `0` 表示零价，`-1` 表示动态或未知价格。模型版本、Pro/Mini/Flash、Free/Batch 等差异保留；无法可靠匹配时显示未计价，可用配置提供明确别名或合同价。

[OpenRouter schema](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md)中的 `overrides`：

- 条件之间为 AND；`min_prompt_tokens` 为严格大于阈值。
- UTC 时间窗为包含起点、不包含终点的半开区间，支持跨午夜。
- 多个条目命中时，后项逐价格字段覆盖，未覆盖的字段继承基础价。

缓存读取、写入分别计价。推理属于输出子集；如模型公布不同的推理单价，用 `(输出-推理)×普通输出价 + 推理×推理价`，不重复累计输出。缺少缓存 TTL 时无法精确恢复 1 小时缓存写入差价。

## DeepSeek 官方人民币价

来源：[中文模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md)。中文人民币价与英文美元价是独立价目；本插件按人民币价计算后的美元数值属于汇率换算。

2026-11-03 已核实的现行价格（元/百万 Token）：

| 模型 | 时段 | 未缓存输入 | 缓存读取 | 输出 |
| --- | --- | ---: | ---: | ---: |
| deepseek-flash / V4.1-Flash-1017 | 闲时 | 1 | 0.02 | 4 |
| 同上 | 高峰 | 2 | 0.04 | 8 |
| deepseek-v4-pro / V4-Pro-0813 | 闲时 | 4.5 | 0.15 | 13.5 |
| 同上 | 高峰 | 9 | 0.30 | 27 |

高峰是北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00；其余闲时。周末补班也按官方文字中的“周末全天为空闲”处理。

当前 Flash 价格由[2026-09-10 公告](https://api-docs.deepseek.com/zh-cn/news/news260910)确认自当天北京时间 12:00 生效；Pro 价格由[2026-08-13 公告](https://api-docs.deepseek.com/zh-cn/news/news260813)确认自 8 月 17 日 00:00 生效。Pro 过去的计划下线公告被后续[更新日志](https://api-docs.deepseek.com/zh-cn/updates)撤回，当前价目仍保留 Pro。历史回填不能无条件套用过去的夜间优惠。

官方未明确跨峰谷边界的请求按开始还是结束时刻结算。插件采用请求开始边界及半开时间窗作为估算约定。官方旧 Flash 路由别名仅按现行页面明确说明处理，不推测其他旧型号自动升级。

## 节假日

2026 年数据依据[国务院办公厅放假安排](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)核实。后续使用附政府公告链接的 [holiday-cn](https://github.com/NateScarlet/holiday-cn) 年度数据，检查年份、公告、有效日期和放假条目；HTTP 200 但空日历不会被视为已核实。年底同时尝试下一年数据以涵盖跨年日期。后续自动更新的日历标注第三方来源，允许配置覆盖。

## 参考汇率

主源为 [Frankfurter v2](https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY)，备用为 [ExchangeRate-API](https://www.exchangerate-api.com)。比较数据发布日期，主源落后时尝试备用源。休市或网络异常可能只能取得最近发布日的数据，界面会显示实际日期。

汇率为 `CNY / USD`：美元金额乘汇率得到人民币，人民币金额除汇率得到美元。两种显示不能相加。不同来源的参考价不一定相同，也不是用户账户实际换汇价。插件只保留兑换所需的单一货币对与来源，不再分发完整外汇 feed；使用备用源时保留其署名链接。

## 未涵盖费用

当前标准 DSH 事件未提供对应成功次数或计费量时，Search/Fetch、图片、音频、视频等附加费不推测补收。DeepSeek [Search/Fetch 文档](https://api-docs.deepseek.com/zh-cn/guides/search.md)规定自 2026-11-01 起每 1,000 次成功请求各 5 元；不能用界面工具卡片数代替服务端成功次数。

独立子会话各自统计，继承的分支前缀不重复记为新消费。套餐、渠道加价、税费和账户折扣不由公共模型价目推断。历史账单只更新说明文字，不因刷新价格而重新估值。
