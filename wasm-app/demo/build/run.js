// SfW 部署物 Node 入口：node run.js [app.js 路径]（默认同目录 app.js）
const path = require("path");
const runtime = require(path.join(__dirname, "js", "wasm-runtime.js"));
runtime.mainCli(path.join(__dirname, "app.js"));
