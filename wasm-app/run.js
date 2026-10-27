// run.js —— SfW 一键运行入口（Node）
//   node run.js                  → 主演示（build/wasm/app.js）
//   node run.js hello            → 本仓 demo：hello-subl（demo/build/app.js）
//   node run.js <app.js 路径>    → 任意 Sublimation --target=wasm 编译产物
const path = require("path");
const fs = require("fs");
const runtime = require(path.join(__dirname, "js", "wasm-runtime.js"));

const TARGETS = {
    hello: path.join(__dirname, "demo", "build", "app.js"),
    main: path.join(__dirname, "build", "wasm", "app.js"),
};

let target = process.argv[2];
if (!target) {
    console.error("用法: node run.js <hello | main | app.js 路径>");
    console.error("  hello = demo/hello-subl（最小完整 demo）；main = 主演示；或传任意产物路径");
    process.exit(2);
}
if (TARGETS[target]) target = TARGETS[target];
else if (!path.isAbsolute(target)) target = path.resolve(target);
if (!fs.existsSync(target)) {
    console.error("[run.js] 找不到目标: " + target + "（先在仓根 compile，见 wasm-app/demo/README.md）");
    process.exit(2);
}
runtime.run(target).then((r) => {
    if (r.ok) { process.exit(0); return; }
    console.error("[run.js] 应用执行失败 (" + r.kind + "): " + (typeof r.error === "object" ? JSON.stringify(r.error) : r.error));
    process.exit(1);
}).catch((e) => {
    console.error("[run.js] 宿主错误: " + (e && e.stack ? e.stack : String(e)));
    process.exit(1);
});
