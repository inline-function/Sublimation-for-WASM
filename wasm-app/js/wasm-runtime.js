"use strict";
// wasm-runtime.js —— SfW 宿主（t38：宿主桥 ABI 统一版）：把 Sublimation 编译产物跑进 QuickJS-in-WASM
//
//  ============================================================================
//  Target.Wasm 宿主规范 v1.1（速查；完整版 wasm doc/宿主规范.md）
//  ============================================================================
//  C1 装载契约
//     实例化 wasm 模块（newQuickJSWASMModuleFromVariant）→ newContext →
//     注入桥接（C2）→ evalCode(产物) → [若产物导出 __subl.main 则由宿主调用]
//     → 驱动 pending jobs（C3）→ 释放全部 handle（C4）。
//  C2 桥接契约（t38 定案 ABI）
//     唯一入口：globalThis.__subl.call(op, args)——op 为操作名（Str），args 为
//     Sublimation 实参数组（List）。宿主侧用一个 op 注册表（OPS，单一真源）实现，
//     op 名与编译器桥分派一致（print 的 op 为 "println"）。
//     桥调用一律经 __subl.call（编译器内建桥 op + 用户 @host 无体声明，
//     t43 已统一生成 __subl.call("<声明名>", [args])）。宿主不向 VM 注入任何
//     桥全局名（t40 曾临时保留的裸名别名已回撤）。
//     桥返回值只允许原语（Str/Nat/Int/Rat/Bool/Null）或句柄（Optional/List/结构体）。
//  C3 pending-jobs 驱动契约（wasm 无隐式事件循环，main 恒 async）
//     evalCode 之后宿主必须循环：while (runtime.hasPendingJob())
//       runtime.executePendingJobs(N)；有唤醒/总数上限，超限按不收敛报错（C5）。
//  C4 handle 契约
//     宿主创建的每个 handle 必须被 dispose；用注册表（HandleRegistry）统一回收；
//     newFunction 回调收到的实参句柄归 FFI 拥有，不得 dispose。
//  C5 错误契约
//     结果分类：ok/load/eval/pending/host；未知 op 抛明确错误；平台不可用能力
//     （sleep/wasmFetch）以明确错误暴露，不静默吞。
//  ============================================================================
//
// 用法：node wasm-runtime.js [app.js 路径]（默认 ../build/wasm/app.js 或 $SFW_APP_JS）

const fs = require("fs");
const path = require("path");

const VENDOR_NM = path.join(__dirname, "..", "vendor", "quickjs", "node_modules");
const { newQuickJSWASMModuleFromVariant } = require(path.join(VENDOR_NM, "quickjs-emscripten-core"));
const RELEASE_SYNC = require(path.join(VENDOR_NM, "@jitl", "quickjs-wasmfile-release-sync")).default;

// ---- 宿主规范 v1 默认值 ----
const SPEC = {
    maxWakeups: 4096,
    maxJobsPerWakeup: 2048,
    maxTotalJobs: 2000000,
    memoryLimitBytes: 256 * 1024 * 1024,
};

// 宿主侧环境表：wasmEnv op 从这里取（演示宿主注入的环境）
const HOST_ENV = {
    phase: "1",
    shell: "sfw",
    target: "wasm",
    lang: "sublimation",
};

// 宿主侧存储（wasmStorage* op 的落地）：Node 宿主=进程内 Map；
// 浏览器宿主应换成 localStorage/IndexedDB（见 wasm-runtime-web.mjs）
const storage = new Map();

// ---- 句柄注册表（C4）----
class HandleRegistry {
    constructor(vm) { this.vm = vm; this.items = []; }
    keep(h) { this.items.push(h); return h; }
    disposeAll() {
        for (let i = this.items.length - 1; i >= 0; i--) {
            try { this.items[i].dispose(); } catch (e) { /* 已释放或内置句柄 */ }
        }
        this.items = [];
    }
}

// 从实参数组句柄提取元素句柄（getProp 产物，归调用方，必须 dispose）
function argHandles(vm, argsH) {
    const hs = [];
    let lenH = null;
    try {
        lenH = vm.getProp(argsH, "length");
        const n = vm.getNumber(lenH);
        for (let i = 0; i < n; i++) hs.push(vm.getProp(argsH, String(i)));
        return hs;
    } finally {
        if (lenH) try { lenH.dispose(); } catch (e) { /* */ }
    }
}

async function run(appJsPath, opts) {
    opts = opts || {};
    const spec = Object.assign({}, SPEC, opts.spec || {});
    const code = fs.readFileSync(appJsPath, "utf8");
    const lines = [];
    const out = opts.onLine || ((s) => { process.stdout.write(s + "\n"); });
    const emitLine = (s) => { lines.push(s); if (!opts.silent) out(s); };

    let vm = null;
    try {
        // ---- C1：实例化模块 + 建上下文 ----
        const QuickJS = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
        vm = QuickJS.newContext();
        vm.runtime.setMemoryLimit(spec.memoryLimitBytes);

        const reg = new HandleRegistry(vm);

        // ---- C2：op 注册表（宿主桥单一真源）----
        // 签名：impl(vm, reg, hs) —— hs 为实参 QuickJS 句柄数组
        // 返回：原语自动装箱，或宿主构造的句柄（Optional/List/结构体）
        const someBox = (v) => {
            const s = reg.keep(vm.newObject());
            vm.setProp(s, "tag", reg.keep(vm.newString("Some")));
            vm.setProp(s, "0", reg.keep(vm.newString(v)));
            return s;
        };
        const noneBox = () => {
            const n = reg.keep(vm.newObject());
            vm.setProp(n, "tag", reg.keep(vm.newString("None")));
            return n;
        };

        const OPS = {
            // 输出（编译器把 print 映射为 op "println"；参数已在编译期 __dshtoStr）
            println: (vm, reg, hs) => { emitLine(hs.map((h) => { try { return vm.dump(h); } catch (e) { return String(h); } }).join(" ")); return vm.undefined; },
            print: (vm, reg, hs) => OPS.println(vm, reg, hs),
            // 命令行参数（宿主注入，opts.appArgs）
            getArgs: (vm, reg, hs) => {
                const arr = reg.keep(vm.newArray());
                (opts.appArgs || []).forEach((s, i) => vm.setProp(arr, String(i), reg.keep(vm.newString(String(s)))));
                return arr;
            },
            // 定时等待：同步 wasm 宿主不可用（宿主规范 §6）
            sleep: (vm, reg, hs) => { throw new Error("[SfW] op sleep 在 wasm 同步宿主下不可用：需 asyncify 变体或 deferred-promise 协议（宿主规范 §6）"); },
            // ---- @wasm @host 桥（app/*.subl；op 名 = 声明函数名）----
            wasmName: (vm, reg, hs) => vm.newString("quickjs-emscripten 0.32.0 (QuickJS in WebAssembly)"),
            wasmTimeMs: (vm, reg, hs) => vm.newNumber(Date.now()),
            wasmEnv: (vm, reg, hs) => {
                const key = vm.getString(hs[0]);
                return vm.newString(String(HOST_ENV[key] != null ? HOST_ENV[key] : "<undefined:" + key + ">"));
            },
            wasmStorageLoad: (vm, reg, hs) => {
                const v = storage.get(vm.getString(hs[0]));
                return v == null ? noneBox() : someBox(v);
            },
            wasmStorageStore: (vm, reg, hs) => { storage.set(vm.getString(hs[0]), vm.getString(hs[1])); return vm.undefined; },
            wasmStorageHas: (vm, reg, hs) => (storage.has(vm.getString(hs[0])) ? vm.true : vm.false),
            wasmStorageRemove: (vm, reg, hs) => { storage.delete(vm.getString(hs[0])); return vm.undefined; },
            wasmStorageKeys: (vm, reg, hs) => {
                const arr = reg.keep(vm.newArray());
                let i = 0;
                for (const key of storage.keys()) { vm.setProp(arr, String(i), reg.keep(vm.newString(key))); i++; }
                return arr;
            },
            wasmStorageClear: (vm, reg, hs) => { storage.clear(); return vm.undefined; },
            // 网络前瞻声明（app/net.subl）：明确「不可用」
            wasmFetch: (vm, reg, hs) => { throw new Error("[SfW] op wasmFetch 暂不可用：同步宿主无法等待网络 IO；落地见宿主规范 §6"); },
        };

        const dispatcher = (opH, argsH) => {
            const op = vm.getString(opH);
            const impl = OPS[op];
            if (!impl) throw new Error("[SfW] 未知宿主桥 op：" + op + "（op 表见 wasm doc/平台边界.md §1）");
            return argRun(argsH, impl);
        };
        // 提取（owned）→ 调用 → 释放（C4）
        function argRun(argsH, impl) {
            const hs = argHandles(vm, argsH);
            try { return impl(vm, reg, hs); } finally { for (const h of hs) try { h.dispose(); } catch (e) { /* */ } }
        }

        // ---- C2：安装 globalThis.__subl.call（唯一 ABI 入口）----
        const sublObj = reg.keep(vm.newObject());
        const callFn = reg.keep(vm.newFunction("call", dispatcher));
        vm.setProp(sublObj, "call", callFn);
        vm.setProp(vm.global, "__subl", sublObj);
        // 编译器 S-1 导出会合并进这个对象：(globalThis.__subl || ...).main = …

        // ---- C1：求值产物 ----
        let error = null;
        const result = vm.evalCode(code);
        if (result.error) {
            try { error = vm.dump(result.error); } catch (e) { error = String(result.error); }
            if (result.error.dispose) try { result.error.dispose(); } catch (e) { /* */ }
        } else if (result.value && result.value.dispose) {
            try { result.value.dispose(); } catch (e) { /* */ }
        }

        // ---- C1：S-1 兼容（--target 产物导出 __subl.main，宿主调用之）----
        if (!error) {
            error = tryCallExportedMain(vm, reg);
        }

        // ---- C3：驱动 pending jobs ----
        let jobsExecuted = 0;
        if (!error) {
            const drained = drainPendingJobs(vm, spec);
            jobsExecuted = drained.jobs;
            if (drained.error) error = drained.error;
        }

        reg.disposeAll();
        vm.dispose();
        vm = null;
        return { ok: !error, kind: error ? (error.kind || "eval") : "ok", error: error ? (error.message || error) : null, lines: lines, jobs: jobsExecuted };
    } catch (e) {
        if (vm) { try { vm.dispose(); } catch (e2) { /* */ } }
        return { ok: false, kind: "host", error: (e && e.message ? e.message : String(e)), lines: lines, jobs: 0 };
    }
}

// S-1 兼容：若产物声明了 __subl.main（编译器 --target 落地后的导出面），
// 由宿主调用之；-A 路线产物无导出 main → 跳过。
function tryCallExportedMain(vm, reg) {
    let sublH = null;
    try {
        sublH = vm.getProp(vm.global, "__subl");
        const mainH = vm.getProp(sublH, "main");
        if (vm.typeof(mainH) !== "function") { try { mainH.dispose(); } catch (e) { /* */ } return null; }
        const callRes = vm.callFunction(mainH, vm.undefined);
        try { mainH.dispose(); } catch (e) { /* */ }
        if (callRes.error) {
            let msg = null;
            try { msg = vm.dump(callRes.error); } catch (e) { msg = String(callRes.error); }
            if (callRes.error.dispose) try { callRes.error.dispose(); } catch (e) { /* */ }
            return { kind: "eval", message: "__subl.main() 抛出: " + (msg && msg.message ? msg.message : msg) };
        }
        if (callRes.value && callRes.value.dispose) try { callRes.value.dispose(); } catch (e) { /* */ }
        return null;
    } catch (e) {
        return { kind: "host", message: "调用导出 main 失败: " + (e && e.message ? e.message : String(e)) };
    } finally {
        if (sublH && sublH.dispose) try { sublH.dispose(); } catch (e) { /* */ }
    }
}

// C3：pending-jobs 驱动循环
function drainPendingJobs(vm, spec) {
    let jobs = 0;
    let wakeups = 0;
    try {
        while (vm.runtime.hasPendingJob()) {
            wakeups++;
            if (wakeups > spec.maxWakeups) {
                return { jobs: jobs, error: { kind: "pending", message: "pending-jobs 超过 " + spec.maxWakeups + " 次唤醒仍未排空（疑似死循环）" } };
            }
            const res = vm.runtime.executePendingJobs(spec.maxJobsPerWakeup);
            if (typeof res === "number") {
                jobs += res;
            } else if (res && res.error) {
                return { jobs: jobs, error: { kind: "pending", message: "异步任务失败: " + (res.error.message || vm.dump(res.error) || String(res.error)) } };
            }
            if (jobs > spec.maxTotalJobs) {
                return { jobs: jobs, error: { kind: "pending", message: "pending-jobs 总数超过上限 " + spec.maxTotalJobs } };
            }
        }
        return { jobs: jobs, error: null };
    } catch (e) {
        return { jobs: jobs, error: { kind: "pending", message: "pending job 崩溃: " + (e && e.message ? e.message : String(e)) } };
    }
}

function mainCli(defaultAppJs) {
    const appJs = process.argv[2] || process.env.SFW_APP_JS || defaultAppJs || path.join(__dirname, "..", "build", "wasm", "app.js");
    if (!fs.existsSync(appJs)) {
        console.error("[wasm-runtime] 找不到 app.js: " + appJs + "（参数传 app.js 路径，或先在仓根跑 compile）");
        process.exit(2);
    }
    run(appJs).then((r) => {
        if (r.ok) {
            process.exit(0);
        } else {
            console.error("[wasm-runtime] 应用执行失败 (" + r.kind + "): " + (typeof r.error === "object" ? JSON.stringify(r.error) : r.error));
            process.exit(1);
        }
    }).catch((e) => {
        console.error("[wasm-runtime] 宿主错误: " + (e && e.stack ? e.stack : String(e)));
        process.exit(1);
    });
}

if (require.main === module) {
    mainCli(null);
}
module.exports = { run: run, mainCli: mainCli, HOST_ENV: HOST_ENV, SPEC: SPEC };
