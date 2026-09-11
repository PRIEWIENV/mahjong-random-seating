# 起飞前检查清单

> [English](RUNBOOK.md) · 简体中文

有先后顺序——不要跳步。带锁标记的步骤进入冻结状态；此后任何东西都不得再修改。

部署是这份清单里的一步，位置在 **B** 和 **C** 之间，由 [`../deploy/README.zh.md`](../deploy/README.zh.md) 承担。它不可能更早：第一条命令就要检出第 11 步打出的那个 tag，而正是那个 tag 才把 `data/protocol.json` 和 `data/roster.json` 带进 checkout。

## A. 实现阶段（还没有真实选手参与）

1. 按 `PROTOCOL.zh.md`、`PANTHEON-INTEGRATION.zh.md` 和 `UI-SPEC.zh.md` 把应用做出来。
2. 把它指向 Pantheon 实例上的一场**测试活动**，配十二个虚拟账号，目标轮次只设在几分钟之后。把整条路走一遍：登录 → 提交 → 等待 → 开奖 → 结果 → 同步。
3. 双向验证登录门禁：报名了这场活动的账号能进；一个有效但**没有**报名这场活动的 Pantheon 账号被拒绝，并给出正确的提示文案。
4. 跑门槛的两侧边界：**8 份提交**必须正常开奖；**7 份必须被判作废**，而不是崩溃，也不是照开不误。
5. 在第二台机器上，仅凭 `results.json` 重算一次已完成的抽签——贡献值、R、种子、排列——并确认逐字节一致，**整个文件，不得挑出任何字段不比**。这一步是抓住贡献哈希里字节编码松动的那一步。
    - 然后加上 `--snapshot events/snapshot.json` 再跑一遍。这是另一种检查：逐字节比对是从文件自己列出的载荷重算的，所以它没法告诉你这份名单是完整的。点名核对可以，而 `--verify` 在拿不到快照时会大声说出来。
6. 检查同步是否真的生效：用 `GetPrescriptedEventConfig` 把 prescript 读回来，用 `WIND_SHUFFLE_MODE_PRESCRIPTED` 跑 `MakePrescriptedSeating`，确认 Pantheon 里第 1 节的座位和应用自己的第 1 轮完全一致，**风位也要一致**。这一步最容易悄无声息地出错。
7. 确认 `results.json` 里带着 R、排列、drand 签名、参与者的 local id 和 `excluded_local_ids`，并且仅凭这些字段，另一台机器就能离线重算出同一张座位表。同时确认它**没带别的东西**——任何不是 `generate.js` 算出来的内容，都得从「逐字节一致」这个主张里挖出去。

## B. 冻结

**先排练一遍。** `npm run rehearse` 会把 B、C、D 全部执行一遍——名册快照、冻结、打 tag、十二份封存的提交、催缴名单、开奖、同步，以及选手事后会做的核验——在一个用完即弃的 git 仓库里，对手是 Pantheon 桩和一个三分钟后的真实 drand 轮次。它要跑约三分钟，而且它是唯一能在「某一步不工作」这件事还便宜的时候把它找出来的办法。它一直在赚回这个成本：`freeze.js` 曾经造不出它本该造的那份名册；一次被拒绝的冻结却照样写了名册；服务器启动时宣布自己已就绪，然后死掉；开奖把密文完全正常的选手排除在外。

`node tools/freeze.js` 执行第 10 和第 11 步，并对任何只会在开奖之后才浮现的问题直接拒绝。加 `--write` 快照名册，加 `--tag <name>` 提交并打 tag。不加 `--tag` 时它不改动 git 里的任何东西，只打印那两条命令。

8. 在 Pantheon 里：把活动标记为 prescripted，准确地登记这十二位选手，并给每个人一个 `local_id`（`UpdatePlayersLocalIds`）。到场但不参赛的人应当标为 `ignore_seating`。
9. 选定目标轮次：`node tools/pick-round.js --in 72h --write` 会把 `target_round`、`submission_cutoff_utc`、`chain_hash` 和 `chain_public_key` 一起设好，让它们不可能互相矛盾。留一个宽裕的窗口——**72 小时**是个不错的默认值——配 `quorum: 8` 和 `user_input_max: 255`。
    - `protocol.json` 里必须**只有**冻结参数（`PROTOCOL.zh.md` §4.1）。一旦里面出现运营配置键，服务器拒绝启动并指名道姓。任何运营性的东西都归 `data/runtime.json`，那个文件不打 tag。
    - `chain_public_key` 必须存在，且必须是 `<drand api>/<chain_hash>/info` 此刻报告的值。没有它，客户端无法分辨自己在跟哪条链说话。
    - 这一步排在名册快照之前，因为冻结拒绝在 `target_round` 为 0 的情况下运行：没有轮次的冻结不叫冻结。
10. `node tools/freeze.js --event <id> --write` 把那份名册从 Pantheon 读回来，据此写出 `data/roster.json`。如果参赛人数不等于 `total_slots`、有人没有可用的 `local_id`、同一个账号登记了两次，或者某位选手没有名字，它就拒绝——而且任何一种情况下它什么都不写，因为基于一份刚被拒绝的报名表建出来的名册，比没有名册更糟。以上每一种问题否则都会落在开奖之后：缺 `local_id` 会卡住座位表同步，而同步是在座位表已经生成之后才跑的。
    - `--event <id>` 只在这场活动第一次冻结时需要。之后 event id 就在 `roster.json` 里，并且以它为准：一个命令行参数不能把已有的冻结重新指向另一场活动。
    - 不加 `--write` 时，命令只报告它打算做什么，不改动任何东西。
11. 🔒 `node tools/freeze.js --write --tag frozen-v1`。在往 git 里写任何东西之前，它会重新推导模板的每一条已证明不变量、从源码重建浏览器 bundle 并与已提交的那份对比、跑一遍单元测试。它提交 `roster.json`、`protocol.json`、`schedule_template.json` 和 `generate.js`——就这四个，没有别的——外加构建好的 bundle 和它的哈希，然后打 tag。`runtime.json` 被 gitignore，并且刻意不在 tag 里。
    - bundle 重建这项检查必须发生在**这里**。它需要 esbuild，而 VPS 上没有（`npm ci --omit=dev`）；VPS 跑的是 `--verify-hash`，那只比对已提交的 bundle 和它已提交的哈希，无法告诉你这个哈希是不是从另一份源码算出来的。

    配好远程仓库之后加上 `--push`。一个只存在于这台机器上的 tag 不构成承诺：谁也拉不到它，而且组织者仍然可以在看到结果之后再决定它指向哪个 commit（`PROTOCOL.zh.md` §9）。这条命令同时会用 OpenTimestamps 给 commit id 做锚定，把证明留在 `events/freeze/<tag>.commit.ots`——保管好那个文件。

    然后从**不是这台机器**的地方确认一下：

    ```sh
    git ls-remote --tags <repo url> <tag>
    ```

## C. 提交窗口

`ADMIN_TOKEN=... npm run serve` 会把面板放在 `/admin?token=…`。它是只读的：开奖、重置和同步都是在机器上执行的命令，因为 §9 要求任何可能触发或改变开奖时机的东西彻底不经过 HTTP。

12. 给选手发一个链接——不是个人链接，不带 token：他们用本来就有的 Pantheon 账号登录。`tools/freeze.js --tag` 会打印一段可以直接复制的通知，里面写清三件要紧事：一个 0 到 255 之间的数字，只填一次；填完可以立刻关掉页面；开奖时间在这里，tag 在这里。

    `freeze.js` 现在打印的通知里除了 tag 还带 commit id。两个都发出去。如果之后有人拿给你一个指向别的 commit 的 tag，群里那条消息就是打脸的证据。
13. 临近截止时催还没交的人。面板第一块就是按姓名列出的那份名单，选手端的等待页显示同样的计数。两者都不透露任何人数字的任何信息——只有**是否**提交了，以及什么时候。`npm run rehearse` 会断言这两半：名单恰好是没有提交的那些人，且页面和它的 JSON 里都不出现任何密文。
    - 也盯着起飞前面板。`Mirroring to the repository: DISABLED` 意味着除了这台服务器之外没人在给密文打时间戳，而公平性论证正是靠那个第三方支撑的。生产环境里出现 `Pantheon adapter is the STUB` 意味着登录是假的。

## D. 开奖与公布

14. 截止之后，确认任务跑过了，`results.json` 已写出并推送。面板的结果面板显示 `round_used`、R、种子、排列和 `results.json` 的摘要；选手端的结果页会自己渲染出来。
15. 确认 Pantheon 同步成功——`events/sync.json` 里的 `status`，面板的同步面板里也有，以及在 Pantheon 管理界面里能看到 prescript。如果失败了，把 `results.json` 里的 `pantheon_prescript` 手工粘进去，并用 `WIND_SHUFFLE_MODE_PRESCRIPTED` 应用。**不要重跑开奖。** 同步失败永远碰不到 `results.json`，那个文件只写一次，并且始终权威。

    如果有人在全新克隆上跑 `--verify` 失败了，让他检查一下开奖之前的检出：`git check-attr text eol -- public/app.js` 应当报告 `-text`。Git 改写行尾会改变冻结产物的字节，从而改变它的摘要，这看起来和被篡改一模一样，而它并不是。

16. 把选手引到结果页。任何愿意核验的人，都应当能仅凭公开信息复现出同一张座位表：

    ```sh
    git checkout <tag>            # 第 11 步公布的那一个
    node generate.js --verify results.json     # 整个文件，外加点名核对
    python3 tools/verify_template.py data/schedule_template.json
    ```

    第一条把 `results.json` 的每一个字节和一次从它所揭示的载荷重新算出的结果比对，然后检查 `events/snapshot.json` 是否对截止时收到的每一份提交都有交代。第二条从轮次数据重新推导模板已证明的性质，而不是相信文件自己的说法。

## E. 活动结束之后

有开始的流程，就要有结束的流程。跳过它不是不整洁，而是错的：一场活动留下的每一样东西都比它活得久，而下一场会继承它们。

**停掉 relay。** Ctrl+C，或者 `systemctl stop`。它会结束等待页持有的那些流，等完仍排在镜像队列里的东西，然后在毫秒级退出。已经在进行的开奖会被留着跑完。真要立刻停就按第二次。

**收尾这场活动。** 座位表同步完、这一轮的事都办完之后：

```sh
node tools/end-event.js --dry-run     # 它会归档什么、清理什么
node tools/end-event.js
```

它把整次尝试归档进 `events/rounds/<target_round>/`——收到时的密文、截止时刻取的提交名单、结果、同步结果，以及它们所依据的那份冻结 `protocol.json` 和 `roster.json`——重算归档里每一个摘要，然后才清理 `var/` 和 `events/` 下的现场文件。归档校验不过，就什么也不清。

**要在冻结下一场之前做，不是之后。** 两个理由，其中一个事后无法补救：

- `protocol.json` 会被下一次冻结覆盖。先收尾，才能把这些密文当初封给的那个轮次和那条链一起放进归档里。之后再收尾，归档里仍有证据，但没有了「证据依据的是什么」，而 `tools/end-event.js` 会把这件事说出来。
- 在你收尾之前，服务器回答的仍然是上一场活动。`phaseOf` 在磁盘上没有 `results.json` 时读持久化的 phase，所以新一场的选手会被展示上一场的座位表。现在服务器在这种状态下会**拒绝启动**而不是把它端出去，你会因此发现自己把顺序做反了。

一轮因为人数不足而作废，是另一回事，不走这条路。那是 §8 的重试：同一场活动、同样十二个人、一个新的目标轮次，用 `tools/new-round.js`。

`events/` 被 gitignore 了，所以配了镜像的话归档会进仓库，没配的话它只存在于那台机器上。工具会告诉你是哪种。

## 出问题的时候

- **提交不足 8 份。** 按 `PROTOCOL.zh.md` §8：本轮作废，另定一个目标轮次，让**所有人**——包括已经提交过的——重新提交。旧密文绑定在已经过去的那一轮上，不能再用。顺序如下：

  1. 任务已经发布了 `events/void.json`，并把这次尝试归档在 `events/rounds/<target_round>/` 下。确认归档在那里而且完整；`tools/new-round.js --dry-run` 会检查它，并且什么都不改。
  2. 选新轮次并重新冻结：`node tools/pick-round.js --in 72h --write`，然后提交 `roster.json`、`protocol.json`、`schedule_template.json` 和 `generate.js` 并再次打 tag。公布新 tag。
  3. `node tools/new-round.js`。它重新验证归档，然后清掉在线的提交和阶段状态，让新一轮可以开启。如果第 2 步没做，它拒绝执行；它永远不碰归档。
  4. 告诉选手三件事：新的 tag；**全部十二人**都必须重新提交；上一次尝试已公布在 `events/rounds/<target_round>/`，谁想确认它确实没达到门槛都可以去看。等那一轮的信标落地之后，`tools/decrypt-submissions.js --dir events/rounds/<r>/submissions --protocol events/rounds/<r>/protocol.json` 能打开归档里的每一份密文。

  作废尝试里的任何东西在任何时候都不会被删除。重置只清在线的表，而且只要归档验证不通过它就拒绝运行。
- **到点时 drand 连不上。** 这是延迟，不是安全问题。密文和轮次都已固定，结果早已确定；等信标能连上时重跑开奖任务即可。
- **某个 drand 镜像挂了。** 把 `data/runtime.json` 指向另一个并重启。这不碰任何冻结的东西，也不需要公告：链由 `chain_hash` 和 `chain_public_key` 钉死，所以一个端点没法换成另一条链（`PROTOCOL.zh.md` §4.2）。
- **Pantheon 换了端口或主机。** 同样的答案——改 `runtime.json`，重启，不需要重新打 tag。
- **Pantheon 同步失败。** 抽签仍然是终局的；`results.json` 权威。任务会带退避重试三次，并把结果记进 `events/sync.json`；一旦记录了失败它就自行停止重试，因为补救手段是人工的。手工粘贴 `pantheon_prescript`，用 `WIND_SHUFFLE_MODE_PRESCRIPTED` 应用。不要重跑开奖。
- **服务器或开奖任务在同步中途死了。** 什么都不用做。如果从来没有记录过结果，开奖任务的下一次运行会自己把同步做完；无论哪种情况 `results.json` 都不会被碰，因为它只写一次。
- **开奖之后 `var/` 丢了。** 什么都不用做，也没有任何东西处于风险中。在所有要紧的地方 `results.json` 都压过数据库，所以任务不会重新开奖，也不会把这一轮判作废，API 会从磁盘上把已发布的结果供出去。
- **有选手登录不进来。** 检查他是否在 Pantheon 里报名了这场活动，以及 `local_id` 是否设好。如果他确实被漏在名册之外，那是一次冻结错误：诚实的补救是作废并用正确的十二人重新冻结，而不是在窗口期内打补丁改名册。
