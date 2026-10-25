"use strict";
// wasm-runtime.js —— SfW 宿主（Phase 1 投产版）：把 Sublimation 编译产物跑进 QuickJS-in-WASM
//
//  ============================================================================
//  Target.Wasm 宿主规范 v1（速查；完整版 wasm doc/宿主规范.md）
//  ============================================================================
//  C1 装载契约
//     实例化 wasm 模块（newQuickJSWASMModuleFromVariant）→ newContext →
//     注入桥接 → evalCode(产物) → [若产物导出 __subl 则由宿主调 __subl.main()]
//     → 驱动 pending jobs → 释放全部 handle → 销毁上下文。
//  C2 桥接契约
//     @wasm @host 无体声明被编译器翻成**裸名全局 JS 调用**；宿主以
//     vm.setProp(vm.global, <name>, vm.newFunction(...)) 注入同名全局；
//     返回值只允许原语（Str/Nat/Int/Rat/Bool/Null）或句柄（Optional/List/结构体）。
//  C3 pending-jobs 驱动契约（wasm 无隐式事件循环，main 恒 async）
//     evalCode 之后宿主必须循环：while (runtime.hasPendingJob())
//       runtime.executePendingJobs(N) —— 返回执行数或错误对象；
//     唤醒次数与总任务数都有上限，超限视为不收敛（死循环嫌疑）报错；
//     异步桥接（@async）若要可等待，需 asyncify 变体或 deferred-promise 协议（见规范 §6）。
//  C4 handle 契约
//     宿主创建的每个 handle（newObject/newFunction/newArray/evalCode 结果/
//     getProp/callFunction 结果）必须被 dispose；用注册表统一回收，
//     否则 vm.dispose() 时 QuickJS 触发 list_empty(&rt->gc_obj_list) 断言 abort。
//  C5 错误契约
//     结果分类：load（模块装载）/eval（求值期）/pending（异步任务期）/host（宿主自身）；
//     平台不可用能力必须以明确错误暴露（不静默吞）；本宿主对未实现桥（如 wasmFetch）
//     抛带说明的同步错误。
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
    maxWakeups: 4096,          // C3：pending-jobs 唤醒上限
    maxJobsPerWakeup: 2048,    // C3：每轮最多执行的任务数
    maxTotalJobs: 2000000,     // C3：总任务上限（不收敛保护）
    memoryLimitBytes: 256 * 1024 * 1024, // C5：wasm 堆上限（QuickJS 32 位地址空间内）
};

// 宿主侧环境表：wasmEnv(key) 从这里取（演示宿主注入的环境）
const HOST_ENV = {
    phase: "1",
    shell: "sfw",
    target: "wasm",
    lang: "sublimation",
};

// 宿主侧存储（C2 落地）：Node 宿主=进程内 Map；浏览器宿主应换成 localStorage/IndexedDB
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

async function run(appJsPath, opts) {
    opts = opts || {};
    const spec = Object.assign({}, SPEC, opts.spec || {});
    const code = fs.readFileSync(appJsPath, "utf8");
    const lines = [];
    const out = opts.onLine || ((s) => { process.stdout.write(s + "\n"); });

    let vm = null;
    const handles = null;
    try {
        // ---- C1：实例化模块 + 建上下文 ----
        const QuickJS = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
        vm = QuickJS.newContext();
        vm.runtime.setMemoryLimit(spec.memoryLimitBytes);

        const reg = new HandleRegistry(vm);

        // ---- C2：注入桥接 ----
        // console.log：Sublimation print 的落地（codegen: console.log(__dshtoStr(v))）
        const consoleObj = reg.keep(vm.newObject());
        const logFn = reg.keep(vm.newFunction("log", (...args) => {
            const parts = args.map((a) => {
                try { return vm.dump(a); } catch (e) { return String(a); }
            });
            const line = parts.join(" ");
            lines.push(line);
            if (!opts.silent) out(line);
        }));
        vm.setProp(consoleObj, "log", logFn);
        vm.setProp(vm.global, "console", consoleObj);

        installBridge(vm, reg, "wasmName", () => vm.newString("quickjs-emscripten 0.32.0 (QuickJS in WebAssembly)"));
        installBridge(vm, reg, "wasmTimeMs", () => vm.newNumber(Date.now()));
        installBridge(vm, reg, "wasmEnv", (k) => {
            const key = vm.getString(k);
            return vm.newString(String(HOST_ENV[key] != null ? HOST_ENV[key] : "<undefined:" + key + ">"));
        });

        // 存储桥（app/storage.subl）：Optional/List 用与编译器一致的 JS 形状构造
        installBridge(vm, reg, "wasmStorageLoad", (k) => {
            const key = vm.getString(k);
            const v = storage.get(key);
            if (v == null) {
                const n = reg.keep(vm.newObject());
                vm.setProp(n, "tag", reg.keep(vm.newString("None")));
                return n;
            }
            const s = reg.keep(vm.newObject());
            vm.setProp(s, "tag", reg.keep(vm.newString("Some")));
            vm.setProp(s, "0", reg.keep(vm.newString(v)));
            return s;
        });
        installBridge(vm, reg, "wasmStorageStore", (k, v) => {
            storage.set(vm.getString(k), vm.getString(v));
            return vm.undefined;
        });
        installBridge(vm, reg, "wasmStorageHas", (k) => (storage.has(vm.getString(k)) ? vm.true : vm.false));
        installBridge(vm, reg, "wasmStorageRemove", (k) => {
            storage.delete(vm.getString(k));
            return vm.undefined;
        });
        installBridge(vm, reg, "wasmStorageKeys", () => {
            const arr = reg.keep(vm.newArray());
            let i = 0;
            for (const key of storage.keys()) {
                vm.setProp(arr, i, reg.keep(vm.newString(key)));
                i++;
            }
            return arr;
        });
        installBridge(vm, reg, "wasmStorageClear", () => {
            storage.clear();
            return vm.undefined;
        });

        // 网络前瞻声明（app/net.subl）：本阶段明确「不可用」（C5）
        installBridge(vm, reg, "wasmFetch", () => {
            throw new Error("[SfW] wasmFetch 暂不可用：同步宿主无法等待网络 IO；落地需 asyncify 变体或 deferred-promise 协议（见 wasm doc/宿主规范.md §6）");
        });

        // ---- C1：求值产物 ----
        let error = null;
        const result = vm.evalCode(code);
        if (result.error) {
            try { error = vm.dump(result.error); } catch (e) { error = String(result.error); }
            if (result.error.dispose) try { result.error.dispose(); } catch (e) { /* */ }
        } else if (result.value && result.value.dispose) {
            try { result.value.dispose(); } catch (e) { /* */ }
        }

        // ---- C1：S-1 兼容（--target=wasm 落地后：产物导出 __subl，宿主调 main()）----
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
        return { ok: !error, kind: error ? error.kind || "eval" : "ok", error: error ? error.message || error : null, lines: lines, jobs: jobsExecuted };
    } catch (e) {
        if (vm) { try { vm.dispose(); } catch (e2) { /* */ } }
        return { ok: false, kind: "host", error: (e && e.message ? e.message : String(e)), lines: lines, jobs: 0 };
    }
}

function installBridge(vm, reg, name, fn) {
    const h = reg.keep(vm.newFunction(name, fn));
    vm.setProp(vm.global, name, h);
}

// S-1 兼容：若产物声明 globalThis.__subl（编译器 --target 落地后的导出面），
// 由宿主调用 __subl.main()；今天的 -A 路线产物是自执行 IIFE，无导出 → 跳过。
function tryCallExportedMain(vm, reg) {
    let sublH = null;
    try {
        sublH = vm.getProp(vm.global, "__subl");
        const dumped = vm.dump(sublH);
        if (dumped === undefined || dumped === null) return null;
        const mainH = reg.keep(vm.getProp(sublH, "main"));
        const callRes = vm.callFunction(mainH, vm.undefined);
        if (callRes.error) {
            try { return { kind: "eval", message: "__subl.main() 抛出: " + vm.dump(callRes.error) }; } finally { try { callRes.error.dispose(); } catch (e) { /* */ } }
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
