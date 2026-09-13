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
- [ ] 证书，nginx，`connect-src` 里有 Frey 的源 —— [指南 §7](../deploy/README.zh.md#7-tls-和反向代理)
- [ ] 启动了，重启之后还在 —— [指南 §8](../deploy/README.zh.md#8-启动)
- [ ] 四条 `curl` 检查，`/admin` 全绿，`tools/check-signin.js --email <你的邮箱>` 和 `--admin` —— [指南 §9](../deploy/README.zh.md#9-公布之前先检查)

## C. 提交窗口

12. [ ] 把冻结时打印出的通告发出去：一个链接、tag、commit id、截止时间 —— [指南 §10](../deploy/README.zh.md#10-公布)
13. [ ] 在 `/admin` 上催还没提交的人；盯着它的起飞前检查面板 —— [指南 §11](../deploy/README.zh.md#11-窗口期间)

## D. 开奖与公布

14. [ ] 截止并且信标到了之后：`/admin` 显示 `round_used`、R、排列；`results.json` 已在仓库里 —— [指南 §12](../deploy/README.zh.md#12-开奖)
15. [ ] `events/sync.json` 说 ok，Pantheon 里能看到座位表；不然就手工把 `pantheon_prescript` 贴进去，用 `WIND_SHUFFLE_MODE_PRESCRIPTED` 应用——绝不重新开奖 —— [指南 §12](../deploy/README.zh.md#12-开奖)
16. [ ] 把选手指向结果页；页面上的核验命令就是 [指南 §13](../deploy/README.zh.md#13-选手可以自己核验什么) 里那一段

## E. 活动结束之后

- [ ] `node tools/end-event.js --dry-run`，然后 `node tools/end-event.js` —— 在下一次冻结**之前** —— [指南 §14](../deploy/README.zh.md#14-收尾)

## 出问题的时候

| 症状 | 做什么 | 指南 |
|---|---|---|
| 提交不足 8 人 | 什么都没丢：这次尝试已归档，`void` 已公布。`node tools/new-round.js --dry-run`，选新轮次，重新冻结、打 tag，`node tools/new-round.js`，通知**全部十二人**重新提交 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 开奖时连不上 drand | 等。任务每分钟重试；结果在截止时就已经定了 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 某个 drand 镜像挂了 | 改 `data/runtime.json`，重启。冻结的东西一点没动，不用重新打 tag | [§15](../deploy/README.zh.md#15-出问题的时候) |
| Pantheon 搬家了 | 一样：`runtime.json`，重启 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 同步失败 | 手工贴 prescript。不要重新开奖 | [§12](../deploy/README.zh.md#12-开奖) |
| 服务器在开奖中途死了，或者 `var/` 没了 | 再启动一次。它会把剩下的做完，绝不重新开奖 | [§15](../deploy/README.zh.md#15-出问题的时候) |
| 某个选手登录不了 | `node tools/check-signin.js --email <他的邮箱>` 会说是哪一步失败 | [§9](../deploy/README.zh.md#9-公布之前先检查) |
| 没有人在开奖 | `/admin` 上 **The draw job has run** 那一行说明定时器是否还活着 | [§15](../deploy/README.zh.md#15-出问题的时候) |
