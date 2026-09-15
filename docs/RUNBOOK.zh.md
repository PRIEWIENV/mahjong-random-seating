# 活动检查清单

> [English](RUNBOOK.md) · 简体中文

每一步一行，按顺序来。每一行的完整做法都在 [`../deploy/README.zh.md`](../deploy/README.zh.md) 里，行末标着对应的节。第一次照着那份指南从头做到尾，第二次用这一页。标着 🔒 的步骤进入冻结状态：在它之后，任何被冻结的东西都不能再改。

## A. 第一次办活动之前

- [ ] `npm run rehearse` 在你的电脑上通过——B、C、D 全程，在沙盒里，对着 Pantheon 的替身
- [ ] `npm run e2e` 对着你的 Pantheon 上的一个测试活动通过——A2 选手的完整流程，A3 登录闸门的两个方向，A4 人数门槛：8 人开奖、7 人作废，A5 只凭 `results.json` 复算一次开奖，A6 同步后读回、含风位，A7 单凭那个文件就能离线复算
- [ ] `node tools/pantheon-fixture.js --accounts` 搭出了那个测试活动，含十二个已知密码的账号

## B. 冻结——在你的电脑上

8. [ ] 在 Pantheon 里：活动是 prescripted，恰好十二人报名，每个人都有 `local_id`，到场不打的人标为 `ignore_seating` —— [指南 §1](../deploy/README.zh.md#1-pantheon-里的活动)
9. [ ] `node tools/pick-round.js --in 72h --write` —— [指南 §3](../deploy/README.zh.md#3-选定目标轮次)
10. [ ] `node tools/freeze.js --event <id> --write` —— 从 Pantheon 读出 `data/roster.json`，否则拒绝并且什么都不写 —— [指南 §4](../deploy/README.zh.md#4-冻结并打-tag)
11. 🔒 [ ] `node tools/freeze.js --write --tag <name> --push` —— 然后在另一台机器上 `git ls-remote --tags <repo> <name>`，并保存 `events/freeze/<name>.commit.ots` —— [指南 §4](../deploy/README.zh.md#4-冻结并打-tag)

## 部署——在服务器上

- [ ] Node 24+，克隆，`git checkout <tag>`，`npm ci --omit=dev`，`node tools/build-client.js --verify-hash` —— [指南 §5](../deploy/README.zh.md#5-在-tag-上安装)
- [ ] `.env` 写好并 `chmod 600`；`data/runtime.json` 填上 Pantheon 地址和 `trust_proxy: true`；Pantheon 同机时加 hosts 记录 —— [指南 §6](../deploy/README.zh.md#6-配置)
- [ ] `node tools/setup-mirror.js` —— 取得 GitHub token、验证确实能写、写进 `.env`；没有它，密文就不会在到达时被公开 —— [指南 §6](../deploy/README.zh.md#6-配置)
- [ ] 证书，nginx，`connect-src` 里有 Frey 的源 —— [指南 §7](../deploy/README.zh.md#7-tls-和反向代理)
- [ ] 启动了，重启之后还在 —— [指南 §8](../deploy/README.zh.md#8-启动)
- [ ] 四条 `curl` 检查，`/admin` 全绿，`tools/setup-mirror.js --check`，`tools/check-signin.js --email <你的邮箱>` 和 `--admin` —— [指南 §9](../deploy/README.zh.md#9-公布之前先检查)

## C. 提交窗口

12. [ ] 把冻结时打印出的通告发出去：一个链接、tag、commit id、截止时间 —— [指南 §10](../deploy/README.zh.md#10-公布)
13. [ ] 在 `/admin` 上催还没提交的人；盯着它的起飞前检查面板 —— [指南 §11](../deploy/README.zh.md#11-窗口期间)

## D. 开奖与公布

14. [ ] 截止并且信标到了之后：`/admin` 显示 `round_used`、R、排列；`results.json` 已在仓库里 —— [指南 §12](../deploy/README.zh.md#12-开奖)
15. [ ] `events/sync.json` 说 ok，Pantheon 里能看到座位表；不然就手工把 `pantheon_prescript` 贴进去，用 `WIND_SHUFFLE_MODE_PRESCRIPTED` 应用——绝不重新开奖 —— [指南 §12](../deploy/README.zh.md#12-开奖)
16. [ ] 把选手指向结果页；页面上的核验命令就是 [指南 §13](../deploy/README.zh.md#13-选手可以自己核验什么) 里那一段

## E. 活动结束之后

- [ ] `node tools/end-event.js --dry-run`，然后 `node tools/end-event.js` —— 在下一次冻结**之前** —— [指南 §14](../deploy/README.zh.md#14-收尾)

## F. 决赛轮

只适用于 `protocol.json` 里带 `final_round` 块的赛事（PROTOCOL.zh.md §11）。它发生在 E 节本来会执行的好几周之后——所以**不要先关闭赛事**；反正锁定文件一旦存在，`end-event.js` 就会拒绝。

这一节全部内容归结为一条规则：名次和信标一起公布，在那个信标存在之前。其余都由它推出。

**如果有人中途退赛**，在第 17 步之前、在事情发生的当时就处理，而不是等到锁定的时候：

- 替补沿用该座位**原有的 Pantheon 注册位**——不要把他登记成第十三个人。座位就是一个 `local_id`；保持它不变，名次表才会是十二行、每行十一场，抽签也才会与没有换人时完全一致。
- 写 `data/substitutes.json`（复制 `data/substitutes.example.json`）：哪个座位、替补从第几轮上场、谁离开、谁接替、以及**允许此事的联赛规则**。没有写理由，这个文件不会被加载。
- 没有别的事要做。`lock-final.js` 会把它显示出来、对着冻结花名册核对、并抄进锁定文件，使它与名次落在同一个指纹和同一个时间戳之下。为什么这份记录可以写得晚而不会变成杠杆，见 PROTOCOL.zh.md §11.6。

17. [ ] 十一轮全部打完并录进 Pantheon。`node tools/lock-final.js`——干跑，什么也不写——然后读它打印的内容：十二个人、每人十一场、它本地重排出来的顺序和 Mimir 给的一致
17a. [ ] 如果干跑说名次表是**空的**，说明这个赛事在比赛期间隐藏成绩。改用 `--as-admin` 重跑——并读它随后打印的警告：那个模式会把*已开始但未结束*的对局也算进去，所以要确认没有任何一桌还在打

18. [ ] `node tools/lock-final.js --in 45m --confirm`。它会写出 `events/final/lock.json`、镜像它、并盖上时间戳。**现在就把它打印的 sha256 通告给十二个人**，连同 drand 轮次和预计出块时间——那一轮落地之后，这串摘要就什么也证明不了了
19. [ ] 那一轮落地之后：`node tools/draw-final.js --dry-run`，然后 `node tools/draw-final.js`。它会等信标、公布 `final.json`、并把全部十二块 prescript 写进 Pantheon
20. [ ] `events/final/sync.json` 显示 ok。如果不是，手工把 `pantheon_prescript` 的**全部十二块**粘贴进去，`next_session_index = 12`，`WIND_SHUFFLE_MODE_PRESCRIPTED`——绝不重跑抽签

有两件事最好在被问到之前就知道：

- 桌次来自**十一**轮之后的名次。如果十二局等重，最终名次可能与之不同——一桌的四个人未必就是最终前四。这是赛制如此，不是出错。
- 有些人最后是 4-3-3-2 而不是 3-3-3-3，结果页会告诉每个这样的人他当时真实的概率（*m* 分之一，*m* 是他那桌有多少人缺同一门风）。平均大约九个人能补齐；十二个人全部补齐的情况只有约 3.7%。完整论证见 [seating-design.zh.md](seating-design.zh.md)。
## 出问题的时候

| 症状 | 做什么 | 指南 |
|---|---|---|
| 提交不足 8 人 | 什么都没丢：这次尝试已归档，`void` 已公布。`node tools/new-round.js --dry-run`，选新轮次，重新冻结、打 tag，`node tools/new-round.js`，通知**全部十二人**重新提交 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 开奖时连不上 drand | 等。任务每分钟重试；结果在截止时就已经定了 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 某个 drand 镜像挂了 | 改 `data/runtime.json`，重启。冻结的东西一点没动，不用重新打 tag | [§15](../deploy/README.zh.md#15-出问题的时候) |
| Pantheon 搬家了 | 一样：`runtime.json`，重启 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 同步失败 | 手工贴 prescript。不要重新开奖 | [§12](../deploy/README.zh.md#12-开奖) |
| 服务器在开奖中途死了，或者 `var/` 没了 | 再启动一次。它会把剩下的做完，绝不重新开奖 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 名次工具拒绝：「和 rating desc 排出来的顺序不一致」 | Mimir 没有采纳 `order_by`。把 `runtime.json` 的 `pantheon.rating_order_by` 改成它确实接受的列；两个顺序不一致之前，什么也不会被写下 | [PROTOCOL §11.5](PROTOCOL.zh.md) |
| 有两个人在第 4|5 名或第 8|9 名并列 | 按联赛自己的规则裁决，在 Pantheon 里把名次改对，然后把规则记下来：`--tiebreak 4 --tiebreak-reason "…"`。工具自己从不破并列 | [PROTOCOL §11.5](PROTOCOL.zh.md) |
| 某个选手登录不了 | `node tools/check-signin.js --email <他的邮箱>` 会说是哪一步失败 | [§9](../deploy/README.zh.md#9-公布之前先检查) |
| 没有人在开奖 | `/admin` 上 **The draw job has run** 那一行说明定时器是否还活着 | [§15](../deploy/README.zh.md#15-出问题的时候) |
