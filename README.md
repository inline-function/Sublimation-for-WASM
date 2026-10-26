# Sublimation for WASM

这个工程让 Sublimation 获得运行在 WebAssembly 上的能力。

**现状**：Phase 0 ✓ → Phase 1 ✓ → **主链路已切 `--target=wasm`**（t40，fat jar 实测）：
宿主桥 ABI 单入口 `__subl.call`（内建桥 op）+ S-1 导出（main 不自执行，宿主调用）。
编译器（t43 落定，fat jar 实测）**桥调用一律 `__subl.call`**：内建桥 op 与用户
`@host` 无体声明统一单入口（op = 声明名）；宿主不注入任何桥全局名
（t40 时期的裸名别名已回撤）。

- 路线决策与 Phase 1 现状：[wasm doc/路线选型.md](wasm%20doc/路线选型.md)
- 宿主规范（用户要求的 pending-jobs 驱动契约所在）：[wasm doc/宿主规范.md](wasm%20doc/宿主规范.md)
- 平台边界（可用/不可用/编译期拒绝归属/给 t35 的接口清单）：[wasm doc/平台边界.md](wasm%20doc/平台边界.md)
- Phase 0 验证记录：[wasm doc/Phase 0 验证记录.md](wasm%20doc/Phase%200%20验证记录.md)

## 目录结构

| 目录 | 内容 |
| --- | --- |
| wasm doc/ | 路线选型 / 宿主规范 v1 / 平台边界 / Phase 0 验证记录 |
| wasm-app/ | 壳工程：QuickJS-in-WASM 宿主（js/wasm-runtime.js Node 主路径 + js/wasm-runtime-web.mjs 浏览器入口）+ vendor/quickjs 供应商件 + 打包脚本 |
| app/ | 编译输入：演示程序（main.subl）+ 桥接标准库层（wasm.subl/storage.subl/net.subl）+ core/ 副本 |
| annotation processer/ | wasm.subs 处理器（@wasm 白名单 10 名 + 态度校验 + @postcompile build 打包钩子） |
| test/ | smoke-test.js：真实产物装载回归（18 项）；dispatch-abi-test.js：`__subl.call` 单入口 + S-1 导出 + 未知 op 拒绝契约（13 项） |
| scripts/ | sync-deps.ps1：从主仓同步 core/（真源=主仓） |
| core/ | 处理器脚本的 stdlib 本地副本（不入库；由 scripts/sync-deps.ps1 同步） |

## 运行环境

编译器按 **CWD 相对路径**装载处理器（annotation processer/）与处理器脚本的 stdlib（core/），
因此 **compile 从本仓根运行**。需要 JAVA_HOME（本机用 F:\jdk-17.0.13.11-hotspot）。
首次使用或主仓更新后先同步依赖：

    powershell -ExecutionPolicy Bypass -File scriptssync-deps.ps1

## 端到端流程

    cd F:\SublimationProject\sublimation for wasm
    # 主仓 fat jar（release/sublimation.jar；t37 后形态）
    java -jar F:\KotlinProject\Sublimation\release\sublimation.jar compile app ^
        -o wasm-app\build\app.js --target=wasm ^
        -A wasmApp=wasm-app -A wasmJs=wasm-app\build\app.js
    node wasm-app\build\wasm\run.js      # 部署物 Node 入口（默认装同目录 app.js）
    node wasm-app\js\wasm-runtime.js     # 或直接跑宿主（默认装 build/wasm/app.js）
    node test\smoke-test.js               # 冒烟回归（18 项）
    node test\dispatch-abi-test.js        # ABI 契约回归（13 项）

1. **语义检查 + JS 生成**：`@wasm @host` 无体桥接声明经 wasm.subs 的 op 白名单校验（10 名）；
   `--target=wasm` 下桥调用点（内建桥 op 与 `@host` 无体声明）一律翻成
   `globalThis.__subl.call(op, args)`；产物导出 `globalThis.__subl.main`（S-1，不自执行）。
   wasm 目标对 core/io、core/net
   做模块级编译期拒绝，app/core 副本不挂载这两包（sync-deps 自动剪除）。
2. **编译后阶段**（`@postcompile build`）：组装自包含可部署物 `build/wasm/`——
   app.js + js/ 宿主 + vendor/quickjs 运行时 + index.html + run.js + README.txt。
3. **运行**：宿主按规范 v1.1 装载（C1 装载 → C2 桥接注入 → evalCode → S-1 兼容检查 →
   C3 pending-jobs 抽干 → C4 handle 回收 → 结构化结果）。

演示程序（app/main.subl）：fib(25)、链表平方与求和、存储桥往返（store/load/keys/has/remove）、
宿主桥示范（wasmName/wasmTimeMs/wasmEnv）。

## 宿主桥 ABI（t38 定案；t43 全链路统一）

**唯一入口：**`globalThis.__subl.call(op, args)` 单入口 dispatch（编译器内建桥 op +
用户 `@host` 无体声明 + wasm 宿主 OPS 注册表 + 处理器 op 白名单四方对齐；
编译器 t43 已把 `@host` 统一进单入口，宿主不注入任何桥全局名——t40 时期的裸名
别名已回撤）。console.log 垒片亦已移除（wasm 产物不再引用 console）。
op 表（与 wasm.subs 白名单一一对应）：

| 类别 | op 名 |
| --- | --- |
| 输出（编译器桥分派） | `println`（`print` 映射于此）、`print` |
| 命令行 / 等待 | `getArgs`（可用）、`sleep`（wasm 同步宿主不可用） |
| `@wasm @host` 桥 | `wasmName`/`wasmTimeMs`/`wasmEnv`、`wasmStorage*(6)`、`wasmFetch`（前瞻） |

详见 `wasm doc/宿主规范.md`（C2 契约 v1.1）与 `wasm doc/平台边界.md`。

## wasm 目标标准库层（app/*.subl）

| 文件 | 内容 |
| --- | --- |
| wasm.subl | 宿主信息桥：wasmName/wasmTimeMs/wasmEnv |
| storage.subl | 宿主存储 KV：wasmStorageLoad/Store/Has/Remove/Keys/Clear（Optional/List 形状对齐编译器） |
| net.subl | 网络前瞻声明：wasmFetch（@async；实现待宿主异步化，见宿主规范 §6） |

**平台边界**：fs/getArgs/readLine/sleep 在 wasm 下不可用（编译期拒绝属编译器 Target 层，
见平台边界.md）；演示刻意避开。timeNow/rand 由 QuickJS 引擎自带无需 shim。

## 编译器参数（-A）

| 键 | 说明 |
| --- | --- |
| wasmApp | 壳工程目录（含 build/package-wasm.ps1） |
| wasmJs | 编译器 JS 产物路径 |
| wasmOut | 打包输出目录（默认 wasmApp\build\wasm） |

键名避开安卓处理器的 appDir/jsPath/outDir/sdkDir，可与其共存。

## 相关仓库

- 编译器主仓：KotlinProject/Sublimation（Target 层改动落在这里，见路线选型 §6 + 平台边界 §4）。
- SfA：sublimation for android（-A 路线的先例）。
- SfG：sublimation for game（同模式复现）。
