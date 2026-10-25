"use strict";
// wasm-runtime-web.mjs —— SfW 浏览器宿主（ES 模块入口）
//
// 与 js/wasm-runtime.js（Node/CJS 宿主）实现同一套「Target.Wasm 宿主规范 v1」
// （见 wasm doc/宿主规范.md）：C1 装载、C2 桥接、C3 pending-jobs 驱动、C4 handle、
// C5 错误分类。区别只在模块取得（浏览器变体 + fetch wasm 而非 fs 读文件）、
// 输出（回调写 DOM 而非 stdout）、存储（localStorage 持久化而非进程内 Map）。
//
// 【验证状态】本环境无浏览器自动化工具，此文件为结构性交付（未做运行回归）；
// Node 路径（wasm-runtime.js）为验证过的主路径。

export const SPEC = {
    maxWakeups: 4096,
    maxJobsPerWakeup: 2048,
    maxTotalJobs: 2000000,
    memoryLimitBytes: 256 * 1024 * 1024,
};

const STORAGE_KEY = "sfw.storage.v1";

function loadStorage() {
    try {
        return new Map(Object.entries(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")));
    } catch (e) {
        return new Map();
    }
}

function saveStorage(map) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map.entries())));
    } catch (e) {
        // 无 localStorage 环境（如 file:// 沙盒）退化为内存态
    }
}

export async function run(appJsUrl, opts) {
    opts = opts || {};
    const spec = Object.assign({}, SPEC, opts.spec || {});
    const lines = [];
    const out = opts.onLine || ((s) => { console.log(s); });

    // C1：取浏览器变体（emscripten-module.browser.mjs 自动 fetch 同目录 .wasm）
    const { newQuickJSWASMModuleFromVariant } = await import(
        "./vendor/quickjs/node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.browser.mjs"
    );
    const QuickJS = await newQuickJSWASMModuleFromVariant();
    const vm = QuickJS.newContext();
    vm.runtime.setMemoryLimit(spec.memoryLimitBytes);

    const handles = [];
    const keep = (h) => { handles.push(h); return h; };
    const storage = loadStorage();

    // C2：桥接（与 Node 宿主同名同义）
    const consoleObj = keep(vm.newObject());
    const logFn = keep(vm.newFunction("log", (...args) => {
        const parts = args.map((a) => { try { return vm.dump(a); } catch (e) { return String(a); } });
        const line = parts.join(" ");
        lines.push(line);
        if (!opts.silent) out(line);
    }));
    vm.setProp(consoleObj, "log", logFn);
    vm.setProp(vm.global, "console", consoleObj);

    const bridge = (name, fn) => { const h = keep(vm.newFunction(name, fn)); vm.setProp(vm.global, name, h); };

    bridge("wasmName", () => vm.newString("quickjs-emscripten 0.32.0 (QuickJS in WebAssembly, browser)"));
    bridge("wasmTimeMs", () => vm.newNumber(Date.now()));
    bridge("wasmEnv", (k) => {
        const env = { phase: "1", shell: "sfw", target: "wasm", lang: "sublimation" };
        const key = vm.getString(k);
        return vm.newString(String(env[key] != null ? env[key] : "<undefined:" + key + ">"));
    });
    bridge("wasmStorageLoad", (k) => {
        const v = storage.get(vm.getString(k));
        if (v == null) {
            const n = keep(vm.newObject());
            vm.setProp(n, "tag", keep(vm.newString("None")));
            return n;
        }
        const so = keep(vm.newObject());
        vm.setProp(so, "tag", keep(vm.newString("Some")));
        vm.setProp(so, "0", keep(vm.newString(v)));
        return so;
    });
    bridge("wasmStorageStore", (k, v) => { storage.set(vm.getString(k), vm.getString(v)); saveStorage(storage); return vm.undefined; });
    bridge("wasmStorageHas", (k) => (storage.has(vm.getString(k)) ? vm.true : vm.false));
    bridge("wasmStorageRemove", (k) => { storage.delete(vm.getString(k)); saveStorage(storage); return vm.undefined; });
    bridge("wasmStorageKeys", () => {
        const arr = keep(vm.newArray());
        let i = 0;
        for (const key of storage.keys()) { vm.setProp(arr, i, keep(vm.newString(key))); i++; }
        return arr;
    });
    bridge("wasmStorageClear", () => { storage.clear(); saveStorage(storage); return vm.undefined; });
    bridge("wasmFetch", () => {
        throw new Error("[SfW] wasmFetch 暂不可用：同步宿主无法等待网络 IO（见 wasm doc/宿主规范.md §6）");
    });

    // C1：取产物（fetch 文本）
    let code;
    try {
        code = await (await fetch(appJsUrl)).text();
    } catch (e) {
        return { ok: false, kind: "load", error: String(e), lines: lines, jobs: 0 };
    }

    // C1：求值
    let error = null;
    const result = vm.evalCode(code);
    if (result.error) {
        try { error = vm.dump(result.error); } catch (e) { error = String(result.error); }
        if (result.error.dispose) try { result.error.dispose(); } catch (e) { /* */ }
    } else if (result.value && result.value.dispose) {
        try { result.value.dispose(); } catch (e) { /* */ }
    }

    if (!error) {
        // S-1 兼容
        try {
            const sublH = vm.getProp(vm.global, "__subl");
            if (vm.dump(sublH) != null) {
                const mainH = keep(vm.getProp(sublH, "main"));
                const callRes = vm.callFunction(mainH, vm.undefined);
                if (callRes.error) error = "__subl.main() threw: " + vm.dump(callRes.error);
                else if (callRes.value && callRes.value.dispose) try { callRes.value.dispose(); } catch (e) { /* */ }
            }
            if (sublH && sublH.dispose) try { sublH.dispose(); } catch (e) { /* */ }
        } catch (e) {
            error = { kind: "host", message: String(e) };
        }
    }

    // C3：pending-jobs 驱动
    let jobs = 0;
    if (!error) {
        let wakeups = 0;
        try {
            while (vm.runtime.hasPendingJob()) {
                wakeups++;
                if (wakeups > spec.maxWakeups) { error = { kind: "pending", message: "pending-jobs 超过 " + spec.maxWakeups + " 次唤醒（疑似死循环）" }; break; }
                const res = vm.runtime.executePendingJobs(spec.maxJobsPerWakeup);
                if (typeof res === "number") jobs += res;
                else if (res && res.error) { error = { kind: "pending", message: "异步任务失败: " + (res.error.message || String(res.error)) }; break; }
                if (jobs > spec.maxTotalJobs) { error = { kind: "pending", message: "pending-jobs 总数超限" }; break; }
            }
        } catch (e) {
            error = { kind: "pending", message: "pending job 崩溃: " + (e && e.message ? e.message : String(e)) };
        }
    }

    // C4：统一回收
    for (let i = handles.length - 1; i >= 0; i--) { try { handles[i].dispose(); } catch (e) { /* */ } }
    vm.dispose();
    return { ok: !error, kind: error ? (error.kind || "eval") : "ok", error: error ? (error.message || error) : null, lines: lines, jobs: jobs };
}
