# demo —— hello-subl：Sublimation 在 WebAssembly 里跑起来并输出

SfW 的**最小完整 demo**：一个 .subl 源文件（阶乘递归 / 链表处理 / 元组点积 /
宿主桥调用），编译为 `--target=wasm` 产物，由 QuickJS-in-WASM 宿主装载执行，
程序里的 `print` 全部变成真实输出。

## 目录

```
wasm-app/demo/
  main.subl          demo 源码（纯逻辑 + 一个 @impure main 打印输出）
  wasm.subl          宿主桥声明（@wasm @host 无体；wasmName/wasmTimeMs/wasmEnv）
  core/              标准库（junction 到 app/core；sync-deps 负责真源同步）
  app.js             编译器产物（--target=wasm，JS 形态；-o 目标，勿入 build/）
  quickjs.wasm       【归档】真正的 .wasm 字节文件（QuickJS 解释器二进制，见下）
  build/             一键打包的可部署物（app.js + 宿主 + vendor + index.html + run.js）
```

## 编译（从仓根，CWD 装载约定）

```bat
cd F:\SublimationProject\sublimation for wasm
java -jar F:\KotlinProject\Sublimation\release\sublimation.jar compile wasm-app\demo ^
    -o wasm-app\demo\app.js --target=wasm ^
    -A wasmApp=wasm-app -A wasmJs=wasm-app\demo\app.js -A wasmOut=wasm-app\demo\build
```

注意：`-o`（=wasmJs）产物必须与 `-A wasmOut` **同级而非嵌套**——打包脚本先把
OutDir 清空再拷贝 JsPath，产物放在 OutDir 里会被自己删掉（ 主演示同理：
build/app.js 与 build/wasm 同级）。

编译成功后 `wasm-app/demo/build/` 就是自包含可部署物（由 wasm.subs 的
@postcompile 钩子调用 package-wasm.ps1 组装，与主演示完全同一套机制）。

## 跑（Node，一条命令）

```bat
cd F:\SublimationProject\sublimation for wasm
node wasm-app\run.js hello            # demo（= wasm-app/demo/build/app.js）
node wasm-app\demo\build\run.js     # 或直接跑部署物入口
node wasm-app\run.js main             # 主演示
node wasm-app\run.js <任意 app.js>    # 任意 --target=wasm 产物
```

### 实际运行输出（本机终端，逐字）

```
hello from Sublimation, running inside WebAssembly (QuickJS)
fact(5) = 120
fact(10) = 3628800
list = [1,2,3,4,5]
doubled = [2,4,6,8,10]
evens = [2,4]
sum = 15
dot((1,2,3),(4,5,6)) = 32
host = quickjs-emscripten 0.32.0 (QuickJS in WebAssembly)
env target = wasm
fact(20) = 2432902008176640000
elapsed ms = 6
```

这 13 行就是 `main()` 在 QuickJS 字节解释器里执行的结果：`host =` 一行证明
`@wasm @host` 桥经 `__subl.call` 单入口分派到了 Node 宿主。

## 浏览器

```bat
cd F:\SublimationProject\sublimation for wasm\wasm-app\demo\build
python -m http.server 8000
```
浏览器开 `http://localhost:8000/`——index.html 装载 wasm-runtime-web.mjs，
后者实例化同一个 QuickJS-wasm 并把输出逐行写进页面 `<pre id="output">`。
（浏览器入口与主演示共用同一装配；本环境无浏览器工具，
Node 路径为正式回归路径，浏览器路径按 HTTP 资源可达性验证：
index.html / app.js / wasm-runtime-web.mjs / emscripten-module.wasm 全部 200。）

## 哪个是 .wasm？怎么加载？输出在哪？

- **真正的 .wasm 字节文件**：`vendor/quickjs/node_modules/@jitl/
  quickjs-wasmfile-release-sync/dist/emscripten-module.wasm`
  ——QuickJS 解释器的 Emscripten 编译产物（release-sync 变体），
  大小 **503134 B**（491 KB），sha256 =
  `105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232`。
  本 demo 把它**归档**了一份在 `wasm-app/demo/quickjs.wasm`（字节相同，
  便于查看/比对；运行实际加载的是 vendor 下的那一份）。
- **怎么加载**：宿主（js/wasm-runtime.js）调
  `newQuickJSWASMModuleFromVariant(RELEASE_SYNC)` 实例化该 wasm 模块，
  `newContext()` 建虚拟机 → 注入 `globalThis.__subl.call`（桥单入口）→
  `evalCode(app.js)` → 调用 `__subl.main()` → 抽干 pending jobs → 回收 handle
  （宿主规范 v1.1：C1 装载 / C2 桥接 / C3 pending-jobs / C4 handle / C5 错误）。
- **输出在哪**：Sublimation 源里的 `print` 被编译器翻译为
  `__subl.call("println", [...])`；Node 宿主把每行打到 stdout（上面的终端输出），
  浏览器宿主写进页面 `#output`。

## 程序长什么样

```sublimation
fun fact(n: Nat): Nat = if (n < 2) 1 else n * fact(n - 1)

fun doubleAll(xs: List[Nat]): List[Nat] = when (xs) {
    Nil => Nil()
    is Cons(h, t) => Cons(h * 2, doubleAll(t))
}

@impure
fun main(): Null {
    print("hello from Sublimation, running inside WebAssembly (QuickJS)")
    print(concat("fact(5) = ", toStr(fact(5))))
    // ……列表处理 / 点积 / 宿主桥，见 main.subl
    null
}
```

纯逻辑（递归、模式匹配、元组）全部无副作用，只有 `main` 标 `@impure`
负责打印与桥调用——Sublimation 的惯用分层。

## 不影响主演示回归

demo 编译的 wasmOut 是 `wasm-app/demo/build`，与主演示的 `wasm-app/build/wasm`
互不重叠；既有回归照常：

```bat
node test\smoke-test.js        # 18 项（Phase 0 回归 + 存储）
node test\dispatch-abi-test.js # 13 项（__subl.call ABI 契约）
```
