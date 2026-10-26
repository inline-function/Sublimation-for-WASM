// dispatch-abi-test.js —— 宿主桥 ABI 统一验证（t38）：globalThis.__subl.call(op, args) 单入口
//
// 编译器侧 t37 尚未落定（安装版 cli 仍出 -A 裸名产物），此处按任务要求改用
// **注入 __subl.call 的桩**：合成一个「t37 后产物」——S-1 导出 + 只经 __subl.call 调桥，
// 由宿主装载执行，验证单入口 ABI 端到端可用（op 分派、返回值、未知 op 报错）。
//
// 用法：node test/dispatch-abi-test.js
"use strict";
const fs = require("fs");
const path = require("path");
const host = require(path.join(__dirname, "..", "wasm-app", "js", "wasm-runtime.js"));

let fails = 0, checks = 0;
function ok(name, cond, extra) {
    checks++;
    if (cond) console.log("  PASS " + name);
    else { fails++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}

// 合成产物：模拟 t37 后的 --target=wasm 产物形态
//   - 全部平台调用/宿主桥只走 globalThis.__subl.call(op, args)
//   - 入口合并进宿主已安装的 __subl（main 由宿主调用，不自执行）
const stubAppJs = `
(async function () {
    var s = globalThis.__subl;
    s.call("println", ["ABISTUB: start"]);
    s.call("println", ["ABISTUB: host=" + s.call("wasmName", [])]);
    s.call("wasmStorageStore", ["k", "v1"]);
    var r = s.call("wasmStorageLoad", ["k"]);
    s.call("println", ["ABISTUB: load tag=" + r.tag + " v=" + r[0]]);
    s.call("wasmStorageStore", ["k2", "v2"]);
    s.call("println", ["ABISTUB: keys=" + JSON.stringify(s.call("wasmStorageKeys", []))]);
    s.call("println", ["ABISTUB: has=" + s.call("wasmStorageHas", ["k"])]);
    s.call("wasmStorageRemove", ["k"]);
    s.call("println", ["ABISTUB: has_after_remove=" + s.call("wasmStorageHas", ["k"])]);
    s.call("println", ["ABISTUB: env=" + s.call("wasmEnv", ["phase"])]);
    var args = s.call("getArgs", []);
    s.call("println", ["ABISTUB: argv n=" + args.length]);
    s.call("println", ["ABISTUB: main called by host: " + (typeof __mainCalled !== "undefined" ? __mainCalled : "?")]);
})().then(function () { __stubDone = true; }, function (e) { __stubErr = String(e); });
globalThis.__subl.main = async function () {
    globalThis.__mainCalled = true;
    globalThis.__subl.call("println", ["ABISTUB: main via S-1 export"]);
};
`;

(async () => {
    const stubPath = path.join(require("os").tmpdir(), "sfw-abi-stub.js");
    fs.writeFileSync(stubPath, stubAppJs, "utf8");
    const t0 = Date.now();
    const r = await host.run(stubPath, { silent: true, appArgs: ["--example", "42"] });
    const elapsed = Date.now() - t0;

    ok("宿主装载 S-1 桩产物并执行（kind=ok）", r.ok && r.kind === "ok", "error=" + JSON.stringify(r.error));
    ok("输出含 ABISTUB: start（__subl.call(println) 分派成功）", r.lines.indexOf("ABISTUB: start") >= 0, JSON.stringify(r.lines));
    ok("桥返回值正确：wasmName 返回串", r.lines.some((l) => l.indexOf("ABISTUB: host=quickjs-emscripten") === 0), "");
    ok("存储 op 往返：load tag=Some v=v1", r.lines.indexOf("ABISTUB: load tag=Some v=v1") >= 0, "");
    ok("wasmStorageKeys 返回数组", r.lines.indexOf("ABISTUB: keys=[\"k\",\"k2\"]") >= 0, "");
    ok("wasmStorageHas 返回 Bool（true→false）", r.lines.indexOf("ABISTUB: has=true") >= 0 && r.lines.indexOf("ABISTUB: has_after_remove=false") >= 0, "");
    ok("wasmEnv op 分派", r.lines.indexOf("ABISTUB: env=1") >= 0, "");
    ok("getArgs 返回宿主注入参数（n=2）", r.lines.indexOf("ABISTUB: argv n=2") >= 0, "");
    ok("S-1 路径：宿主调用导出 main", r.lines.indexOf("ABISTUB: main via S-1 export") >= 0, "");
    ok("导出 main 在 IIFE 之后执行且输出有序", r.lines.indexOf("ABISTUB: main via S-1 export") > r.lines.indexOf("ABISTUB: start"), "");
    ok("宿主完整运行 < 30s", elapsed < 30000, elapsed + "ms");

    // 未知 op 必须报错（C5）
    const badPath = path.join(require("os").tmpdir(), "sfw-abi-badop.js");
    fs.writeFileSync(badPath, 'globalThis.__subl.call("nopeOp", [1]);', "utf8");
    const bad = await host.run(badPath, { silent: true })
        .catch((e) => ({ ok: false, kind: "host", error: String(e) }));
    ok("未知 op 被明确拒绝（非 ok）", !bad.ok, "kind=" + bad.kind + " err=" + JSON.stringify(bad.error).slice(0, 160));
    ok("错误信息指明未知 op 名", JSON.stringify(bad.error).indexOf("nopeOp") >= 0, "");

    console.log(fails === 0
        ? "DISPATCH-ABI-TEST: ALL PASSED (" + checks + " 项：__subl.call 单入口 + S-1 导出 + 错误契约)"
        : "DISPATCH-ABI-TEST: " + fails + " FAILED");
    process.exitCode = fails === 0 ? 0 : 1;
})().catch((e) => {
    console.error("DISPATCH-ABI-TEST: 宿主异常 " + (e && e.stack ? e.stack : String(e)));
    process.exit(1);
});
