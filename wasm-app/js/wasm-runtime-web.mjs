"use strict";
// wasm-runtime-web.mjs —— SfW 浏览器宿主（ES 模块入口）
//
// 与 js/wasm-runtime.js（Node/CJS 宿主）实现同一套「Target.Wasm 宿主规范 v1.1」
// （见 wasm doc/宿主规范.md）：C1 装载、C2 桥接（t38 定案：__subl.call 单入口 ABI）、
// C3 pending-jobs 驱动（wasm 无隐式事件循环，宿主必须抽干）、C4 handle、C5 错误分类。
// 区别只在模块取得（浏览器变体 + fetch wasm 而非 fs 读文件）、
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
    const emitLine = (s) => { lines.push(s); if (!opts.silent) out(s); };

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
    const HOST_ENV = { phase: "1", shell: "sfw", target: "wasm", lang: "sublimation" };

    // C2：op 注册表（与 Node 宿主同构；impl(vm, reg, hs)，hs 为实参句柄数组）
    const someBox = (v) => {
        const s = keep(vm.newObject());
        vm.setProp(s, "tag", keep(vm.newString("Some")));
        vm.setProp(s, "0", keep(vm.newString(v)));
        return s;
    };
    const noneBox = () => {
        const n = keep(vm.newObject());
        vm.setProp(n, "tag", keep(vm.newString("None")));
        return n;
    };
    const OPS = {
        println: (vm, hs) => { emitLine(hs.map((h) => { try { return vm.dump(h); } catch (e) { return String(h); } }).join(" ")); return vm.undefined; },
        print: (vm, hs) => OPS.println(vm, hs),
        getArgs: (vm, hs) => {
            const arr = keep(vm.newArray());
            (opts.appArgs || []).forEach((s, i) => vm.setProp(arr, String(i), keep(vm.newString(String(s)))));
            return arr;
        },
        sleep: (vm, hs) => { throw new Error("[SfW] op sleep 在 wasm 同步宿主下不可用（宿主规范 §6）"); },
        wasmName: (vm, hs) => vm.newString("quickjs-emscripten 0.32.0 (QuickJS in WebAssembly, browser)"),
        wasmTimeMs: (vm, hs) => vm.newNumber(Date.now()),
        wasmEnv: (vm, hs) => {
            const key = vm.getString(hs[0]);
            return vm.newString(String(HOST_ENV[key] != null ? HOST_ENV[key] : "<undefined:" + key + ">"));
        },
        wasmStorageLoad: (vm, hs) => {
            const v = storage.get(vm.getString(hs[0]));
            return v == null ? noneBox() : someBox(v);
        },
        wasmStorageStore: (vm, hs) => { storage.set(vm.getString(hs[0]), vm.getString(hs[1])); saveStorage(storage); return vm.undefined; },
        wasmStorageHas: (vm, hs) => (storage.has(vm.getString(hs[0])) ? vm.true : vm.false),
        wasmStorageRemove: (vm, hs) => { storage.delete(vm.getString(hs[0])); saveStorage(storage); return vm.undefined; },
        wasmStorageKeys: (vm, hs) => {
            const arr = keep(vm.newArray());
            let i = 0;
            for (const key of storage.keys()) { vm.setProp(arr, String(i), keep(vm.newString(key))); i++; }
            return arr;
        },
        wasmStorageClear: (vm, hs) => { storage.clear(); saveStorage(storage); return vm.undefined; },
        wasmFetch: (vm, hs) => { throw new Error("[SfW] op wasmFetch 暂不可用（宿主规范 §6）"); },
    };

    // 实参数组句柄 → 元素句柄（owned，需释放）
    const argRun = (argsH, impl) => {
        const hs = [];
        let lenH = null;
        try {
            lenH = vm.getProp(argsH, "length");
            const n = vm.getNumber(lenH);
            for (let i = 0; i < n; i++) hs.push(vm.getProp(argsH, String(i)));
            return impl(vm, hs);
        } finally {
            if (lenH) try { lenH.dispose(); } catch (e) { /* */ }
            for (const h of hs) try { h.dispose(); } catch (e) { /* */ }
        }
    };
    const dispatcher = (opH, argsH) => {
        const op = vm.getString(opH);
        const impl = OPS[op];
        if (!impl) throw new Error("[SfW] 未知宿主桥 op：" + op + "（op 表见 wasm doc/平台边界.md §1）");
        return argRun(argsH, impl);
    };

    // C2：安装 globalThis.__subl.call（唯一 ABI 入口）
    const sublObj = keep(vm.newObject());
    const callFn = keep(vm.newFunction("call", dispatcher));
    vm.setProp(sublObj, "call", callFn);
    vm.setProp(vm.global, "__subl", sublObj);

    // @host 裸名通道（生成器当前形态：用户 @host 声明在 browser/wasm 仍出裸名调用；
    // 同一注册表派生；待生成器统一到 __subl.call 后移除——t40 已实测确认并报队长）
    for (const op of Object.keys(OPS)) {
        const alias = keep(vm.newFunction(op, (...hs) => OPS[op](vm, hs)));
        vm.setProp(vm.global, op, alias);
    }
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
        // S-1 兼容：__subl.main 存在则宿主调用
        try {
            const sublH = vm.getProp(vm.global, "__subl");
            const mainH = vm.getProp(sublH, "main");
            if (vm.typeof(mainH) === "function") {
                const callRes = vm.callFunction(mainH, vm.undefined);
                if (callRes.error) {
                    let msg = null;
                    try { msg = vm.dump(callRes.error); } catch (e) { msg = String(callRes.error); }
                    error = { kind: "eval", message: "__subl.main() 抛出: " + (msg && msg.message ? msg.message : msg) };
                } else if (callRes.value && callRes.value.dispose) {
                    try { callRes.value.dispose(); } catch (e) { /* */ }
                }
                try { callRes.error && callRes.error.dispose(); } catch (e) { /* */ }
            }
            if (mainH) try { mainH.dispose(); } catch (e) { /* */ }
            if (sublH) try { sublH.dispose(); } catch (e) { /* */ }
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
