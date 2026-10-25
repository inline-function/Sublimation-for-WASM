# wasm-app/vendor —— QuickJS-in-WASM 供应商件

## 内容

| 组件 | 版本 | 许可 | 来源 |
| --- | --- | --- | --- |
| quickjs-emscripten-core | 0.32.0 | MIT | npm registry |
| @jitl/quickjs-wasmfile-release-sync | 0.32.0 | MIT | npm registry |
| @jitl/quickjs-singlefile-cjs-release-sync | 0.32.0 | MIT | npm registry（备用：wasm 内联的 CJS 变体） |
| @jitl/quickjs-ffi-types | 0.32.0 | MIT | npm registry |

装在 vendor/quickjs/node_modules 下（Node 的模块解析从 wasm-app/js/wasm-runtime.js
向上走不到这里，宿主用绝对路径显式 require，见 wasm-runtime.js 顶部）。

## 为什么用变体包而不是主包

quickjs-emscripten 主包（分发器）静态 require 全部四个 @jitl/* 变体，其中两个 debug
变体各带一份 ~3MB 的 wasm。SfW 只需要 release-sync（wasm 文件 503KB），所以直接
require 核心库 + 单个变体，体积最省、意图最明确。

## 升级

1. 从 npm registry 取新版 tarball（本环境 GitHub 域名不可达，npm/unpkg 可达）；
2. 解包替换 vendor/quickjs/node_modules 下对应目录（注意解包后目录层级是
   package/...，不要多套一层）；
3. 改本文件的版本号与 wasm doc/Phase 0 验证记录.md 的宿主版本号；
4. 跑 node test/smoke-test.js 回归。

## 变体选择

- quickjs-wasmfile-release-sync（**默认**）：wasm 为独立文件，Node 与浏览器（emscripten-module.browser.mjs）都能加载。
- quickjs-singlefile-cjs-release-sync：wasm 以 base64 内联进 CJS，纯 Node 场景最省事（除加载器外无文件 IO）；不用是因为它放弃了浏览器路径。

## 浏览器路径（未验证）

wasmfile 变体自带 emscripten-module.browser.mjs，理论上可用 ES module 在浏览器装载。
Phase 0 只跑了 Node 路径（任务允许其一）；浏览器装载留待 Phase 0.5/1。
