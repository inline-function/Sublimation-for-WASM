# wasm-app —— SfW 壳工程

把 Sublimation 编译产物（JS）跑进 QuickJS-in-WASM 宿主。宿主规范 v1 正本：
`wasm doc/宿主规范.md`（C1 装载 / C2 桥接 / C3 pending-jobs 驱动 / C4 handle / C5 错误）。

## 结构

```
wasm-app/
  js/
    wasm-runtime.js          Node 宿主（CJS，验证过的主路径；CLI 与库两种用法）
    wasm-runtime-web.mjs     浏览器宿主（ES 入口；结构性交付，本环境未做浏览器回归）
  index.html                 浏览器入口页（打包时随产物走）
  vendor/quickjs/            quickjs-emscripten-core 0.32.0 + @jitl 变体（见 vendor/README.md）
  build/
    package-wasm.ps1         打包脚本（wasm.subs 的 @postcompile build 调用）
    app.js                   编译器产物（-o 目标）
    wasm/                    ——可部署物：app.js + js/ + vendor/ + index.html + run.js + README.txt
```

## 运行

```bat
cd F:SublimationProjectsublimation for wasm
F:KotlinProjectSublimationcliuildinstallcliincli.bat compile app ^
    -o wasm-appuildapp.js -A wasmApp=wasm-app -A wasmJs=wasm-appuildapp.js
node wasm-appuildwasmun.js                # 部署物 Node 入口
node wasm-appjswasm-runtime.js               # 或直接跑宿主
node testsmoke-test.js                        # 冒烟回归（18 项）
```

宿主库用法（被 test/smoke-test.js 使用）：

```js
const { run } = require("wasm-app/js/wasm-runtime.js");
const r = await run("build/wasm/app.js", { silent: true, onLine: cb, spec: {...} });
// r = { ok, kind: "ok"|"load"|"eval"|"pending"|"host", error, lines, jobs }
```

## 宿主桥接（t38 定案 ABI：__subl.call 单入口）

宿主安装 `globalThis.__subl.call(op, args)`，内部用 op 注册表（OPS，单一真源）分派；
op 表（与 annotation processer/wasm.subs 的 op 白名单一一对应）：

| op | 实现 |
| --- | --- |
| println/print | 输出行收集（编译器把 print 映射为 println） |
| getArgs / sleep | 宿主注入参数 / 同步宿主不可用（明确错误） |
| wasmName/wasmTimeMs/wasmEnv | 固定串 / Date.now() / 宿主环境表 |
| wasmStorageLoad/Store/Has/Remove/Keys/Clear | 进程内 Map（浏览器宿主=localStorage） |
| wasmFetch（前瞻） | 明确错误「暂不可用」（宿主规范 §6） |

过渡兼容（同一注册表派生，t37 落定后移除）：裸名别名（-A/预 t37 产物仍以裸名调用
`@host` 桥）+ `console.log` 垫片（-A 路线 print 的旧落地点）。

**未提供**（平台边界，见 wasm doc/平台边界.md）：fs 四件套、getArgs、readLine、sleep。

## 路线兼容

宿主双路线兼容：-A 路线产物（自执行 IIFE）与 `--target=wasm` 产物
（`globalThis.__subl.main()`）都能装载（规范 §1 步 5、§7）。
