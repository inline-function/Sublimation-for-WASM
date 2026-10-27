SfW wasm 应用部署物
====================
内容：app.js（程序）+ js/（宿主）+ vendor/quickjs（QuickJS-in-WASM 运行时）
      + index.html（浏览器入口）+ run.js（Node 入口）

Node 运行：
    node run.js                 # 装载同目录 app.js
    node run.js <其他 app.js>

浏览器运行：
    用静态服务器打开 index.html（file:// 会因 fetch wasm 受限——例如
    python -m http.server 后访问 http://localhost:8000/index.html）。
    浏览器路径在本环境中未做运行回归（无浏览器工具），以 Node 路径为准。

宿主规范：wasm doc/宿主规范.md（Target.Wasm 宿主规范 v1）
