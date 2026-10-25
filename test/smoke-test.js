// smoke-test.js —— SfW 冒烟测试（Phase 1）
//
// 用壳工程的 wasm 宿主装载编译产物，断言：
//   - Phase 0 回归基线 11 项（前 7 行输出 + 装载/行数/时长）保持不破坏；
//   - Phase 1 追加：宿主存储桥（wasmStorage*）往返、键集合、删除；
//   - 宿主规范基本卫生：pending jobs 已排空、返回结构化结果。
//
// 用法：node test/smoke-test.js（默认装载 wasm-app/build/wasm/app.js）
"use strict";
const fs = require("fs");
const path = require("path");
const host = require(path.join(__dirname, "..", "wasm-app", "js", "wasm-runtime.js"));

let fails = 0;
let checks = 0;
function ok(name, cond, extra) {
    checks++;
    if (cond) console.log("  PASS " + name);
    else { fails++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}

(async () => {
    const appJs = process.argv[2] || path.join(__dirname, "..", "wasm-app", "build", "wasm", "app.js");
    if (!fs.existsSync(appJs)) { console.error("找不到产物 " + appJs + "；先跑 compile"); process.exit(2); }

    const t0 = Date.now();
    const r = await host.run(appJs, { silent: true });
    const elapsed = Date.now() - t0;

    // ---- 宿主规范卫生 ----
    ok("host.run 返回结构化结果（ok/kind/lines/jobs）", typeof r.ok === "boolean" && Array.isArray(r.lines) && typeof r.jobs === "number", "r=" + JSON.stringify(r).slice(0, 200));
    ok("宿主装载并执行成功（无错误，kind=ok）", r.ok && r.kind === "ok", "error=" + JSON.stringify(r.error));
    ok("pending jobs 已排空并计入（async main 解析）", r.jobs >= 0 && r.kind === "ok", "jobs=" + r.jobs);

    // ---- Phase 0 回归基线（11 项；env phase 随发布进位为 1）----
    const want = [
        "SfW Phase 0: hello from Sublimation, running inside WASM (QuickJS)",
        "host: quickjs-emscripten 0.32.0 (QuickJS in WebAssembly)",
        "fib(25) = 75025",
        "squares = [1,4,9,16,25,36,49,64,81,100]",
        "sum of squares = 385",
        "env phase = 1",
    ];
    for (const w of want) {
        ok("输出含: " + w, r.lines.indexOf(w) >= 0, "got=" + JSON.stringify(r.lines));
    }
    ok("含 elapsed ms 行（wasmTimeMs 桥工作）", r.lines.some((l) => l.indexOf("elapsed ms = ") === 0), "");
    ok("输出行数 >= 7", r.lines.length >= 7, "n=" + r.lines.length);
    ok("宿主完整运行 < 30s", elapsed < 30000, elapsed + "ms");
    ok("Phase 0 基线行序保持（hello 在首行）", r.lines[0] === want[0], "");

    // ---- Phase 1：存储桥 ----
    ok("storage roundtrip: 75025（store→load Some 往返）", r.lines.indexOf("storage roundtrip: 75025") >= 0, "");
    ok("storage keys: [fib25]（keys 返回 List[Str]）", r.lines.indexOf("storage keys: [fib25]") >= 0, "");
    ok("storage has fib25: true（Bool 桥往返）", r.lines.indexOf("storage has fib25: true") >= 0, "");
    ok("after remove has fib25: false（remove 生效）", r.lines.indexOf("after remove has fib25: false") >= 0, "");
    ok("storage keys after remove: []（删除后为空）", r.lines.indexOf("storage keys after remove: []") >= 0, "");

    console.log(fails === 0
        ? "SMOKE-TEST: ALL PASSED (" + checks + " 项：Phase 0 回归 + Phase 1 存储)"
        : "SMOKE-TEST: " + fails + " FAILED");
    process.exitCode = fails === 0 ? 0 : 1;
})().catch((e) => {
    console.error("SMOKE-TEST: 宿主异常 " + (e && e.stack ? e.stack : String(e)));
    process.exit(1);
});
