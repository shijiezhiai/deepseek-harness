# Agent Note: client bundle 传输按有界调度重试

Status: implemented

[English](2026-10-15-bundle-transport-retry-schedule.md) | 中文

## 问题

安装或更新插件会在页面可能已经开始启动的时候重写 profile 的 `node_modules`，落在这段重写窗口内的 `<script>` 请求会失败，而失败的原因下一刻就不成立了。2026-10-15 当天，桌面 profile 的包在 19:51 被重新链接，应用在 19:55 启动：33 个资源的 application combo 对 `dsh-better-sidebar` 返回了无法加载的内容，而两次到达尝试（首次加上 `ClientModuleSystem.arrive` 在同一 tick 内立即重试的那次）都落在同一个窗口里。随后 `web boot: 2 entries did not activate` 传到了桌面 shell，而它的恢复对话框只提供「禁用第三方插件」——该动作会重置 `dsh.profile.bundles` 并备份 `cordis.patch.yml`，于是一次包重写期间的瞬时传输失败让用户失去了所有已装插件。

## 决策

`ClientModuleSystem.arrive` 按 `BUNDLE_RETRY_DELAYS_MS` 调度尝试 bundle URL——立即一次，400 ms 后一次，1.2 s 后再一次，即每个 URL 三次尝试、最多等待 1.6 s。

- **每个 URL 一份调度，由所有等待的行共享。** `transportWaves` 按 URL 保存在途调度，因此同一 batch 的所有行、以及重试期间新加入的每一行都共享这批尝试，而不是各自发起。`loadShared` 不再对在途 bundle 传输去重，该项由调度波拥有。包内 chunk 请求保留自己在 `pendingChunks` 中的在途去重。
- **只有传输失败才重试。** `<script>` 的 `error` 事件意味着什么都没执行，因此重放不会重复注册任何东西。已加载但未注册其行的脚本绝不重新执行；`failedBundleUrls` 与 `executedBundleUrls` 的记账保持不变。
- **单资源回退走同一份调度。** batch 之后仍然缺失的行回退到自己的单资源 combo URL，同样三次尝试，因此一个失败的 batch 每个 URL 最多花费三次请求，且不影响已注册的行。
- **按行的错误带上尝试次数。** 调度耗尽的 URL 在 `assertEntriesActive` 报告的失败文本中贡献一条 `<url>: <传输消息> (retried 2 times)`。

延迟是刻意有界的：这里要覆盖的窗口是约一秒内结束的包重写；而真正缺失的产物必须进入启动审计报告，而不是让启动一直卡住。

## 考虑过的替代方案

**保留同一 tick 内的立即重试。** 否决：那样两次尝试度量的是同一个重写窗口，而这正是缺陷本身；只有延迟后的尝试才能看到已稳定的产物。

**每个行各一份调度。** 否决：batch 的各行会各自对每个 URL 花费三次请求，对一个本就不可用的产物成倍放大请求，并让抓取次数取决于行的 import 顺序。

**更多次数配合指数退避。** 否决：过了第二次延迟后覆盖率增长很慢，而每个无法加载的行都要更久之后才被启动审计报告出来。

**改为在下次 import 时重试，而非定时重试。** 否决：一次启动内 Loader 对每个条目只 import 一次，因此失败行的下一次机会就是它的单资源回退，而启动审计会在任何更晚的 import 之前就判该条目失败。

## 后果

- 约一秒内结束的包重写不再让等待该 batch 或其回退的行失败，因此瞬时失败不再升级为 shell 的「禁用全部插件」对话框。
- 请求上限仍是每份调度每个 URL 三次；加入在途调度波的行共享剩余尝试，而不会增加请求。
- 产物永远无法加载的行现在要等最多 1.6 s 才记录按行失败：这是真实失败所增加的启动时延。
- 两张在途表各有明确归属——`transportWaves` 管 bundle 传输，`pendingChunks` 管包内 chunk。

## 测试

`packages/client/modules/tests/loader.client.spec.ts` 用假定时器驱动该调度：测试 `waits before retrying a failed batch and shares the retry across its rows` 让两个行导入一个失败一次的 batch，断言延迟之前只有一次抓取，推进重试窗口后断言两个行都成功、且第二个行没有额外抓取。调度耗尽的情形断言每个 URL 抓取三次以及 `retried 2 times` 文本。`packages/client/modules/tests/entries.client.spec.ts` 覆盖 HMR 路径：过期的 reload target 在同一份调度下按同一 URL 重试。

## 相关记录

[Fatal diagnostics and crash reports](../architecture/2026-09-22-fatal-diagnostics-and-crash-reports.zh.md) 记录了 batch 失败的按行隔离、单资源回退，以及报告失败条目的启动审计。
