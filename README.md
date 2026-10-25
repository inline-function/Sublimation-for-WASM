# Sublimation for WASM

这个工程让 Sublimation 获得运行在 WebAssembly 上的能力。

**现状**：Phase 0（-A 路线验证）✓ → **Phase 1 投产化** ✓（宿主规范 v1、wasm 标准库层、
可部署物打包链、18 项冒烟回归）→ 等 t35 的 `--target=wasm`（S-1 导出；宿主已双路线兼容）。

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
| test/ | smoke-test.js：wasm 宿主装载演示的冒烟回归（18 项：Phase 0 基线 + Phase 1 存储） |
| scripts/ | sync-deps.ps1：从主仓同步 core/（真源=主仓） |
| core/ | 处理器脚本的 stdlib 本地副本（不入库；由 scripts/sync-deps.ps1 同步） |

## 运行环境

编译器按 **CWD 相对路径**装载处理器（annotation processer/）与处理器脚本的 stdlib（core/），
因此 **compile 从本仓根运行**。需要 JAVA_HOME（本机用 F:\jdk-17.0.13.11-hotspot）。
首次使用或主仓更新后先同步依赖：

    powershell -ExecutionPolicy Bypass -File scriptssync-deps.ps1

## 端到端流程

    cd F:SublimationProjectsublimation for wasm
    F:KotlinProjectSublimationcliuildinstallcliincli.bat compile app ^
        -o wasm-appuildapp.js ^
        -A wasmApp=wasm-app -A wasmJs=wasm-appuildapp.js
    node wasm-appuildwasmun.js     # 部署物 Node 入口（默认装同目录 app.js）
    node wasm-appjswasm-runtime.js    # 或直接跑宿主（默认装 build/wasm/app.js）
    node testsmoke-test.js             # 冒烟回归

1. **语义检查 + JS 生成**：`@wasm @host` 无体桥接声明经 wasm.subs 白名单校验（10 名），
   调用点翻成裸名全局 JS 调用。
2. **编译后阶段**（`@postcompile build`）：组装自包含可部署物 `build/wasm/`——
   app.js + js/ 宿主 + vendor/quickjs 运行时 + index.html + run.js + README.txt。
3. **运行**：宿主按规范 v1 装载（C1 装载 → C2 桥接注入 → evalCode → S-1 兼容检查 →
   C3 pending-jobs 抽干 → C4 handle 回收 → 结构化结果）。

演示程序（app/main.subl）：fib(25)、链表平方与求和、存储桥往返（store/load/keys/has/remove）、
宿主桥示范（wasmName/wasmTimeMs/wasmEnv）。

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
