# 测试装置

这些不是随包发布的文件（打包时用的是显式文件清单），而是开发期用的验证脚本。
每个都能独立运行，用 `node tests/<name>.js` 即可，退出码 0 表示全部断言通过。

它们默认读工作区里的 `content-script.js` / `background.js`，所以改完代码直接跑就是
在测最新版。大多数支持用环境变量指向另一份副本，用来做**反向验证**（把改动前的
代码跑同一套断言，确认它真的会失败）：

```bash
# 从 git 取改动前的版本
git show HEAD~1:content-script.js > /tmp/old.js
LB_CS=/tmp/old.js node tests/poll-cadence.js      # 应当失败
```

## 各装置

| 文件 | 测什么 | 反向验证用的变量 |
|---|---|---|
| `e2e-extension.js` | **真实扩展 + 真实 Chromium + 假服务器**，多个真实标签页：队列行为、控件稳定性、点击的即时反馈 | `LB_EXT`（扩展目录） |
| `worker-concurrency.js` | 直接加载真实的 `background.js`（配假的 `chrome` 与 `fetch`）：一次只压一条、同版本去重 | `LB_BG` |
| `download-queue.js` | 队列机制：排队位置、去重、先进先出、取消排队、worker 重启后队列还在 | `LB_BG` |
| `batch-download.js` | **批量下载**：一次点 10 个，断言全程只有 1 个在传、按点击顺序发出、队列最终清空、没有重复 | `LB_BG` |
| `download-id-validation.js` | 非整数 id 不得发到服务器（`"null"` / `"undefined"` / `""` / 乱码），两个都无效时要返回可读错误 | `LB_BG` |
| `stuck-retry.js` | 传输停滞（完全不动 / 缓慢爬行 / 无进度记录）会自动重试，用尽重试后放弃并给出原因 | `LB_BG` |
| `download-signals.js` | 已用时只增不减；字节数倒退时说明「已重新传输」 | `LB_CS` |
| `list-outage.js` | ComfyUI 未启动时列表页完全静止，以及启动后自动恢复 | `LB_CS` |
| `bubble-scans.js` | 气泡自身的 DOM 重建不得触发列表扫描 | `LB_CS` |
| `poll-cadence.js` | 空闲／隐藏标签页的轮询次数 | `LB_CS` |
| `download-signals.js` | （见上）已用时与「重新传输」提示 | `LB_CS` |
| `click-dispatch-probe.js` | 不是断言套件，是一个探针：光标下的节点在按下与抬起之间被移除时，浏览器到底把 `click` 派发到哪里（答案：**不派发**） | — |

## 两件必须注意的事

1. **假服务器绝对不要用 8188 端口。** 那是用户本机 LoRA Manager 的端口，
   E2E 装置会真的发起下载请求。装置里用的是 18788，并通过 `chrome.storage.sync`
   把扩展指过去。
2. **`e2e-extension.js` 会把扩展复制一份到临时目录并改写 manifest**，加上
   `http://civitai.com/*` 以便用本地 http 服务模拟 CivitAI（真机是 https）。
   测试结束会删掉那份副本。

## 为什么要有 E2E 装置

前面几轮所有测试都用构造的 DOM 固定件，而用户报出来的问题全部发生在真实交互里
——固定件永远比真机宽松。E2E 装置跑的是随包发布的代码本身，用真实鼠标事件驱动，
所以它能抓到「控件被替换导致点击丢失」这类构造件抓不到的东西。

顺带一提，`click-dispatch-probe.js` 推翻了一个我们以为成立的假设（"监听器放在容器上
就能救回跨重渲染的点击"）。留作证据。
