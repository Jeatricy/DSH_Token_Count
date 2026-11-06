# DSH_Token_Count

DeepSeek Harness **0.2.1-rc.5** 和 **0.2.2-rc.1** 的会话用量与费用插件，安装包名为 `dsh-token-cost`。每轮回复结束后，在原生操作栏的 **“用量”之后、时间之前**显示 `本轮估算 ¥… · $…`；输入框下方显示 `会话累计 ¥… · $…`。点击费用可打开明细浮窗，查看 Token、请求数、模型、原币小计、单价、峰谷时段、汇率日期和来源。支持明暗主题、窄屏和键盘操作。

金额是依据公开价目与已报告用量计算的**估算值**；双币是同一笔费用的两种折算，不能相加。原币指价目使用的币种，不代表代理渠道一定以该币种扣款。插件统计用量，不读取账户余额或套餐剩余额度。

## 1.0.3 更新

- 支持 DeepSeek Harness 0.2.2-rc.1，修复升级后插件因版本声明被拒绝加载的问题。

## 1.0.2 更新

- 逐轮费用并入回复底部原生操作栏，紧跟“用量”，位于时间之前；窄屏可自然换行。
- 输入框下方的会话累计费用在右侧栏展开或聊天区变窄时保持单行，空间不足自动显示省略号；悬停查看完整金额，点击仍可打开明细。
- 保留向上费用浮窗、逐轮匹配修复、精确缓存说明和历史价格快照。
- 公共测试可在未安装 Harness 的环境执行；真实 SDK 专属校验在提供参考目录后启用。

## 1.0.1 更新

- 修复逐轮金额显示“暂无用量”：使用 Harness 实际传入的轮次对象中的数字编号匹配账本，并覆盖真实 SDK 的插槽参数回归测试。
- 输入框下方明细改为向上打开的悬浮窗，限制宽高，内部滚动；展开不改变输入框或聊天布局，支持点击外部、Escape 关闭。
- 展开箭头统一为 SVG 图标，提供旋转反馈和键盘焦点样式。
- 缓存提示明确指出缺少读取还是写入，并区分“总 Token 已核对”与确需缺项估算；旧账单仅更新说明，不重新计算金额。

## 安装

已包含浏览器构建产物，使用者无需安装 Node.js 或运行构建。

在 Harness 的 **插件 → 安装第三方插件** 中，填入仓库地址：

```text
https://github.com/Jeatricy/DSH_Token_Count
```

也可以[下载 1.0.3 安装包](https://github.com/Jeatricy/DSH_Token_Count/raw/refs/heads/main/dist/dsh-token-cost-1.0.3.tgz)，将下载后文件的绝对路径填入同一安装窗口。

安装并启用后刷新 Harness 页面；如管理器提示需要重启，请按提示重启。后续更新代码需重新构建和安装，不能假设修改源文件会自动更新当前 GUI。

也可使用官方 CLI：

```sh
dsh plugin --profile desktop add https://github.com/Jeatricy/DSH_Token_Count
```

从插件管理器停用或卸载即可移除显示，独立费用记录会保留。插件无需修改 Harness 安装目录，也不启动额外 HTTP 服务。

## 价格与汇率

- **OpenRouter 全量价目**：使用 [全模态 Models API](https://openrouter.ai/api/v1/models?output_modalities=all)，2026-11-03 快照含 **685** 个模型。默认不带参数的接口只有 451 个文本输出模型。运行时会跟随分页并校验完整性，每天刷新、离线使用缓存。
- **匹配顺序**：自定义价格 → 已核实的 DeepSeek 官方人民币价 → OpenRouter 精确 ID、尾名、官方别名和日期别名 → 保守近似匹配。近似匹配保留版本号和 Pro、Mini、Flash、Free、Batch 等关键区别；歧义、动态 `-1` 价格和未知型号显示“未计价”。合法零价可显示 0。
- **渠道区分**：识别为 OpenRouter 的 provider 使用 OpenRouter 美元价。其他渠道的已知 DeepSeek 型号默认按用户要求参考官方人民币价；这是估算偏好，代理或私有部署可设置自己的价格。旧 `deepseek-chat` 不会擅自映射成最新 Flash。
- **官方 DeepSeek**：每日读取[中文价目表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md)，解析模型版本、缓存命中、未命中、输出与峰谷价。结构或分时规则无法识别时保留原快照并提示，不猜新价格。
- **汇率**：[Frankfurter v2](https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY) 为主，[ExchangeRate-API](https://www.exchangerate-api.com) 为备用。主源非当天时尝试备用源，选择日期较新的数据；显示发布日和来源。参考汇率不含换汇点差，休市或断网只能采用最近可用数据并标明日期，无法取得时保留原币金额。

当前 DeepSeek 价目（元/百万 Token）：

| 模型 | 时段 | 普通输入 | 缓存读取 | 输出 |
| --- | --- | ---: | ---: | ---: |
| deepseek-flash / V4.1-Flash-1017 | 闲时 | 1 | 0.02 | 4 |
| deepseek-flash / V4.1-Flash-1017 | 高峰 | 2 | 0.04 | 8 |
| deepseek-v4-pro / V4-Pro-0813 | 闲时 | 4.5 | 0.15 | 13.5 |
| deepseek-v4-pro / V4-Pro-0813 | 高峰 | 9 | 0.30 | 27 |

高峰为**北京时间周一至周五 09:00–12:00、14:00–18:00，排除中国法定节假日**，其余为闲时。2026 年假期依据[国务院通知](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)核实；后续年份从附政府公告的 holiday-cn 日历自动补充，空数据不会当作“全年无假期”。年末同时尝试下一年度日历以覆盖跨年日期。未知年份会提示按星期和时间估算。

分时以记录的请求开始边界（step/start 或 retry-started）计算，时间窗采用左闭右开。DeepSeek 页面尚未明确跨边界请求究竟按开始还是结束时间结算，因此仍标注估算。OpenRouter 的 UTC 覆盖价按其文档明确的半开时间窗处理。

## 计费口径

每个实际模型请求独立计算，再汇总到所属轮次和会话。切换模型不改变已记录费用。一轮中多次模型/工具往返会累计；重试单独计量，同一次请求重复用量报告只替换、不叠加。

DSH 的 `inputTokens` 已排除缓存 Token：

```text
原币费用 = (未缓存输入 × 输入单价
         + 缓存读取 × 读取单价
         + 缓存写入 × 写入单价
         + 普通输出 × 输出单价
         + 推理输出 × 推理单价) / 1,000,000
         + 已公布的每请求固定费用
```

推理 Token 是输出 Token 的子集；仅当模型公布独立推理价且提供推理数量时拆分，绝不重复加入输出。未公布缓存费率但有缓存用量时按普通输入价估算并提示。支持 OpenRouter 长上下文阶梯价（严格超过阈值才启用）、UTC 分时覆盖价、后项逐价格键覆盖。

美元定价累加到美元原币小计，再乘 `CNY/USD` 得人民币；人民币定价反向除汇率。历史费用保留首次计价时可用的价目、适用规则和汇率快照；同请求用量修正仍使用原价目，包括原来的阶梯规则。

安装前的历史会话可以从日志只读回填，但无法凭今天的价目证明过去的真实扣费，因此会明确标记历史估算。已有已计价记录不会随“刷新价格”变化；刷新会重试未计价记录，并可补全原先缺失的汇率换算。

统计范围为**当前会话自身的模型请求**。分支继承的历史不重复计入新分支；独立子会话、后台标题/摘要等未提供本会话请求用量的调用不并入主会话。供应商未返回用量的失败、取消请求显示未计价；已知部分仍可展示，总额会注明不完整。

公开价目不能反映个人折扣、渠道加价、套餐、税费等。图片、音频、视频、Search/Fetch 等额外计费数量未出现在当前标准 DSH 用量事件时不推测收费；非文本输出模型缺少对应计量数据时显示未计价。DeepSeek 自 2026-11-01 收取 Search/Fetch 成功请求费，但当前 DSH 标准用量未保留服务端成功计数，因此这一项**未计入本插件金额**。

## 自定义模型与人民币价格

复制 [配置模板](config.example.json) 到默认数据目录下的 `config.json`：

```text
%USERPROFILE%\.dsh\token-cost\config.json
```

若设置了 `DSH_HOME`，目录为 `$DSH_HOME/token-cost`。Cordis 配置还可指定 `dataDir` 或 `configFile`。编辑配置后在插件管理中停用、重新启用插件；“刷新价格”仅刷新远端数据，不重新读取配置文件。

示例（私有模型别名、渠道来源和自定义人民币单价；示例自定义价需换成你的真实合同价）：

```json
{
  "preferDeepSeekOfficial": true,
  "allowFuzzy": true,
  "providerSources": { "my-openrouter-route": "openrouter" },
  "aliases": { "my-astra-alias": "openai/gpt-6-astra" },
  "overrides": [
    {
      "provider": "my-provider",
      "model": "my-private-model",
      "currency": "CNY",
      "rates": { "input": 1, "output": 4, "cacheRead": 0.1, "cacheWrite": 1 },
      "sourceUrl": "https://your-provider.example/pricing",
      "schedule": {
        "timeZone": "Asia/Shanghai",
        "weekdays": [1, 2, 3, 4, 5],
        "windows": [["09:00", "12:00"], ["14:00", "18:00"]],
        "excludeChinaHolidays": true,
        "peak": { "input": 2, "output": 8, "cacheRead": 0.2, "cacheWrite": 2 }
      }
    }
  ]
}
```

`rates` 均为每百万 Token 金额，只有可选的 `request` 是每请求金额。`currency` 支持 `USD` / `CNY`；`provider` 省略表示匹配任何渠道。`providerSources` 值 `catalog` 可让指定渠道跳过 DeepSeek 官方优先；`preferDeepSeekOfficial: false` 则全局关闭该优先策略。未在示例中的 `holidays.years[年份].dates` 可以补充已核实日历。

## 存储与实现

默认 `~/.dsh/token-cost/` 保存公开价格缓存、按日汇率与 `ledger/` 下的独立账本。账本仅存会话 ID、调用序号、时间、模型、Token、金额、价目和汇率，不保存消息正文、提示词或 API Key。对外只请求公开价目和汇率地址，不发送会话数据。

使用 Harness 正式 `session/event`、会话只读持久化、`conversation.chat.turnTail` 和 `conversation.composer.dock` 插槽。逐轮费用通过限定在本轮操作栏内的 React Portal 适配器显示，适配器只维护插件自己的容器。操作栏不存在或结构不兼容时回退到回复尾部显示。`engines.dsh` 仅列出已经验证的版本。

HTTP 沿用 Harness 认证及所有者访问控制。文件写入串行化、原子替换；断网或价格接口失败不阻断模型会话。多个进程同时使用同一个自定义账本目录不受支持，请为它们分别配置 `dataDir`。

客户端共享会话查询，完成一轮时刷新，可见页面每 30 秒同步，隐藏页面停止轮询；请求失败保留旧值并显示状态。金额内部不按“分”提前舍入，小额保留至 6 位小数。

## 开发和验证

Node.js 22.12+（本机使用 24.21.0）与 pnpm：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm test
pnpm run sync-prices
pnpm run pack
```

[价格测试](test/pricing.test.js)验证公开价目快照、缓存与推理费用、名称歧义、峰谷边界、长上下文阶梯、FX 回退和分页。宿主/账本测试覆盖重试、重复回填、模型切换、分支、缺用量和持久化。客户端测试覆盖 React、工具栏位置、浮窗、连接切换和键盘操作。公共测试不需要账户密钥或真实会话。

本机提取的 `.reference` 不随仓库发布；未提供参考文件时，真实 SDK 专属检查会明确跳过，公共契约与 DOM 回归仍会执行。浏览器布局验证可运行 `node test/client-browser.js`，需要本机可用的 Chrome/Edge。真实宿主集成脚本为 [host-sdk-integration.mjs](test/host-sdk-integration.mjs)，通过安装版 Electron 的 Node 模式显式运行，只使用临时会话数据。

[用量行预览](artifacts/client-toolbar-light.png)、[暗色浮窗预览](artifacts/client-dark.png)和[窄屏预览](artifacts/client-toolbar-mobile.png)来自使用正式组件的浏览器测试页面，图内标有 DEMO，示例金额不是账户实际消费。

[价格来源与计算边界](docs/PRICING.md)说明公开来源和无法确认的计费项目。仓库不包含本机 SDK 提取、真实会话账本、安装验证记录或研究原始响应。

[MIT License](LICENSE)。
