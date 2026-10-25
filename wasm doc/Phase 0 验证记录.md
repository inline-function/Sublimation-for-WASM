# SfW Phase 0 验证记录

对应任务：以 quickjs-emscripten 做 JS-in-WASM 宿主壳，跑通 -A 处理器路线产出的 JS。
本文记录装载方式、桥接待遇到的限制、与 SfA/SfG 宿主壳的异同，以及遗留事项。

---

## 0. 结论

**Phase 0 跑通**：Sublimation 程序（含 core 标准库与宿主桥接）经编译器产 JS，
由 `wasm-app/js/wasm-runtime.js` 装载进 QuickJS-in-WASM 执行，Node 环境验证
（`node wasm-app/js/wasm-runtime.js` 退出 0，`test/smoke-test.js` 11 项断言全过，
含 fib(25)=75025、链表平方和、宿主桥 wasmName/wasmTimeMs/wasmEnv 的端到端返回）。

## 1. 装载方式

### 依赖取得（网络受限环境的现实）

- 本环境 GitHub 域名不可达，npm registry 可达。quickjs-emscripten 家族（MIT）全部在 npm：
  `quickjs-emscripten-core`（核心库，60KB 压缩 JS）与按宿主形态拆分的 `@jitl/*` 变体包。
- **不取主包 quickjs-emscripten**：它是分发器，静态 require 全部四个 @jitl/* 变体
  （两个 debug 变体各带约 3MB wasm）。SfW 只要 release-sync，故直接
  `require("quickjs-emscripten-core")` + 单个变体——体积与意图都最优。
- 变体对比（实测、本机冷加载）：

| 变体 | 形态 | 实测（Node 24） | 选择 |
| --- | --- | --- | --- |
| @jitl/quickjs-wasmfile-release-sync | wasm 独立文件（503KB） | 装载+eval 56ms | **默认**（Node/浏览器两宜） |
| @jitl/quickjs-singlefile-cjs-release-sync | wasm base64 内联 CJS | 装载+eval 41ms | 备用（仅 Node） |

- 打包成仓库供应商件：`wasm-app/vendor/quickjs/node_modules/`（四个包），宿主脚本用绝对路径
  require（Node 的向上解析碰不到 vendor 目录）——见 vendor/README.md。

### 宿主装载步骤（wasm-runtime.js）

1. `newQuickJSWASMModuleFromVariant(RELEASE_SYNC)`：Emscripten 模块实例化（读 wasm 文件）；
2. `QuickJS.newContext()`：QuickJS 上下文；
3. 注入桥接（见 §2）；
4. `vm.evalCode(appJs)`：产物是自执行 IIFE，`main()` 在 eval 时立即触发；
5. **抽干异步队列**：`main` 恒为 async（编译器对 main 总是 async），async 主体的
   promise 解析需要宿主驱动 `vm.runtime.executePendingJobs()` + `hasPendingJob()`
   循环（注意是 **runtime 上的方法，context 上没有**——这是本阶段翻过的第一个坑）；
6. **handle 释放**：所有 `newObject/newFunction` 与 evalCode 结果的 handle 必须
   `dispose()`，否则 `vm.dispose()` 时 QuickJS 触发
   `Assertion failed: list_empty(&rt->gc_obj_list)`（wasm 侧 abort）——第二个坑。

## 2. 桥接：Sublimation ↔ wasm 宿主

### 提供的桥（对应 app/wasm.subl 的 @wasm @host @impure 声明）

| Sublimation 声明 | 宿主实现 | 备注 |
| --- | --- | --- |
| `wasmName(): Str` | 固定字符串 | 宿主自报家门 |
| `wasmTimeMs(): Nat` | 宿主侧 Date.now() | 计时基准 |
| `wasmEnv(key): Str` | 宿主侧环境表 | 演示宿主注入的环境 |
| `print(v): Null` | codegen 特判 `console.log(__dshtoStr(v))`，宿主注入 console.log | 输出收集 |

调用模型与 SfG 完全一致：`@host` 无体声明 → 编译器生成**裸名全局 JS 调用** →
宿主用 `vm.setProp(vm.global, ...)` 注入同名全局函数。

### 平台限制（桥接待遇到的真实边界）

**不可用**（wasm 宿主没有，演示刻意避开）：

| Sublimation 能力 | codegen 产物 | wasm 宿主现状 |
| --- | --- | --- |
| `readFile/writeFile/appendFile/readDir/fileExists` | `require('fs')` | 无 require、无 fs → 需要宿主实现沙盒 FS（未做） |
| `readLine` | `Buffer + require('fs').readSync(0,...)` | 无 stdin → 沙盒语义 |
| `getArgs` | `process.argv.slice(2)` | 无 process → 需宿主注入参数 |
| `sleep/delay` | `new Promise(r => setTimeout(r,...))` | 无事件循环 `setTimeout` → 需宿主提供（asyncify 变体或自己驱动 pending jobs） |
| `timeNow/rand` | `Date.now()/Math.random()` | QuickJS 自带，**无需 shim** ✓ |

这正是路线选型文档预言的「平台靠运行期失败而非编译期拒绝」（对应 Phase 1 的
`E-PLATFORM-UNAVAILABLE`）。对 demo 的影响：只用纯计算 + print + 三个桥，仍能展示
宿主往返（三次 wasm↔host 跨界调用 + 输出回传）。

### 一个诱因观察

本次实测给 Phase 1 喂了两条具体设计输入：
- `main()` 自执行：wasm 宿主其实更想要 **S-1 导出对象**（eval 后由宿主调
  `__subl.main()`），因为宿主常需要在装载与执行之间注入更多桥（本阶段靠
  eval 前注入绕开，但「装载即执行」让懒装载/热重载变扭）。
- 平台内建的 Node 假设（fs/process）现在就压在 codegen 六处分支上（见路线文档 §6），
  wasm 目标来临时这些必须分派——本次把范围缩小到了具体行号。

## 3. 与 SfA/SfG 宿主壳的异同

| 维度 | SfA（android） | SfG（game） | SfW（wasm，本阶段） |
| --- | --- | --- | --- |
| 宿主 | Android WebView（KT 侧） | 浏览器页（KAPLAY） | QuickJS-in-WASM |
| 语言边界 | JS ↔ Kotlin（JavascriptInterface 桥） | JS ↔ KAPLAY 上下文 | JS ↔ wasm 嵌入式 JS |
| 桥注入点 | WebView 载入前注入全局 | 页面 script 载入前（脚本顺序） | `vm.setProp(vm.global, ...)`（eval 前） |
| 声明机制 | `@android @host` + `__dshAndroid` 分发 | `@game @host` 裸名 | `@wasm @host` 裸名 |
| 处理器纪律 | android.subs 白名单 | game.subs 白名单 | wasm.subs 白名单（3 名） |
| 打包 | @postcompile → 签名 APK | @postcompile → 自包含网页 | @postcompile → wasm 应用包（app.js + run.txt） |
| 异步 | KT 端 dispatch 回 JS | 浏览器事件循环 | **宿主须抽干 pending jobs**（wasm 无自己的事件循环） |
| 生命周期 | 活动事件补发 | 页面 | 无（进程式：eval→jobs→退出） |

共同点是**三者共用一套编译器机制**（@host 无体 + -A 处理器 + @postcompile），
零编译器改动落地新目标；差异全在宿主侧的同步/异步模型与能力沙盒。
SfW 的独有约束是：宿主自己就是 JS 引擎，桥是「wasm 内外两个 JS 世界」的跨界。

## 4. 验证证据

- `cli.bat compile app -o wasm-app\build\app.js -A wasmApp=wasm-app -A wasmJs= wasm-app\build\app.js`
  从仓根跑通（33KB 产物，@postcompile 打包出 wasm/app.js + run.txt）。
- `node wasm-app\js\wasm-runtime.js` → 退出 0，输出：
  hello 行、host 行（wasmName 桥）、`fib(25) = 75025`、`squares = [1..100]`、
  `sum of squares = 385`、`elapsed ms = 179~183`（wasmTimeMs 桥）、`env phase = 0`（wasmEnv 桥）。
- `node test\smoke-test.js` → **SMOKE-TEST: ALL PASSED**（11 项：装载成功、6 行精确输出、
  elapsed 行、行数、时长回归）。
- 冷启动：宿主约 40~60ms（装 wasm 模块），eval + fib(25) 全程 180ms 内。

## 5. 遗留限制（如实清单）

1. **未做真实浏览器回归**（任务的可选项）：本会话没有浏览器自动化工具，wasmfile 变体的
   browser.mjs 路径只是按其类型声明眼测——装載器形态（fetch wasm 还是内联）未验证。
   Phase 0.5 可补：一个最小 HTML 用 ES module 载入 emscripten-module.browser.mjs。
2. **fs/getArgs/readLine/sleep 在 wasm 宿主下不可用**（§2 表）：当前策略是演示避开；
   落地沙盒 FS、参数注入、setTimeout 模拟都是宿主侧工作，量不大但需要先定语义。
3. `async main` 的 pending jobs 抽干是「-spin until empty」的保守循环（上限 1000 轮 × 2048 jobs）；
   没有事件循环集成，`sleep` 类异步 API 无法真实等待。
4. 打包产物是「app.js + 运行说明」，宿主与 wasm 引擎在仓库内不随包走——
   即 wasm 应用当前是**开发者包**而非终端用户可执行（浏览器版需要 Phase 0.5 或 Phase 1 的产物结构改造）。
5. 未测 wasm 内存上限/长时运行稳定性（演示量级无压力，_phase 1 前应补 `runtime.setMemoryLimit` 策略）。

## 6. 对 Phase 1 的输入更新

本次实测让路线选型 §6 的改动清单更具体：

- 改动 3（S-1 导出 + 抑制 main 自执行）对 wasm 目标**确有必要**（§2 末的诱因观察），
  建议作为 wasm/browser/android 共同的产物基座；
- 改动 2 的六处 Node 假设已缩小到 JsCodeGen.kt:1126-1151 的具体分支（本记录 §2 表逐一对应）；
- 建议新增（补清单）：`vm.runtime.executePendingJobs` 式的异步驱动契约应写进
  `Target.Wasm` 的宿主规范——wasm 没有隐式事件循环，main 的 async 语义需要宿主协议。
