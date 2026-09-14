<div align="center">

# 随机麻将座位抽签

**一场十二人的座位抽签：没人能预测，没人能操纵，事后任何人都能核验——包括主持它的那个人。**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2024-5FA04E?logo=node.js&logoColor=white)](package.json)
[![Tests](https://img.shields.io/badge/tests-446%20passing-brightgreen)](test/)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-1-informational)](package.json)
[![drand](https://img.shields.io/badge/randomness-drand%20quicknet-6f42c1)](https://drand.love)

[English](README.md) · 简体中文

</div>

---

十二名选手，十一轮，三桌四人。*谁和谁同桌*由一张固定的、已证明最优的模板决定。*谁落在模板的哪个位置*由一次抽签决定：十二个人都参与贡献，在预先公布的时刻自行揭晓，任何人都能用公开数据重新算一遍。

## 快速开始

需要 Node 24 或更新，以及能上网——抽签用的是公开的 [drand](https://drand.love) 信标。不需要账号，不需要配置。

```sh
git clone https://github.com/<you>/mahjong-random-seating.git && cd mahjong-random-seating
npm ci
npm run demo
```

`npm run demo` 在你的机器上跑一场完整的抽签——十二名选手、三分钟的提交窗口、真实的时间锁、真实的信标——并打印出该看哪里：

```
  Open   http://127.0.0.1:8080

  You are player 1, 阿明: sign in with person_id 5001. The other eleven are
  simulated and will submit over the next minute or so. Submissions close at
  20:41:07; the beacon lands and the draw runs at about 20:42:07.
```

登录，选一个数字，看着其他人的信封陆续到达，等信标，看座位表以及怎么复算它——选手能看到的一切，大约四分钟。看完 Ctrl+C；它跑在一份临时副本里，什么都不留下。只有 Pantheon（俱乐部的账号系统）是模拟的。想多看一会儿：`npm run demo -- --window 600`。

## 工作原理

```mermaid
flowchart LR
  A["每位选手封存<br/>一个数字，仅一次"] --> B["密文到达即公开"]
  B --> C["截止：提交名单<br/>固定并盖时间戳"]
  C --> D["drand 信标到达<br/>目标轮次"]
  D --> E["所有信封<br/>同时打开"]
  E --> F["种子把名字打乱<br/>放到已证明的模板上"]
  F --> G["座位表，任何人<br/>都能复算"]
```

每位选手选一个 0 到 255 之间的整数。浏览器把它和自己生成的十六个随机字节混在一起，用**时间锁加密**封存到未来某一轮 drand 信标——密文在预先定好的那一刻才能读，早一秒都不行。没有任何密钥保管人可以贿赂、传唤或信任：提前打开不是被禁止，而是做不到。

每一份密文到达的那一刻就被公开，并带上第三方的时间戳。截止时，参与名单被固定、摘要，并通过 [OpenTimestamps](https://opentimestamps.org) 锚定进比特币——此时能打开任何一份密文的信标还不存在。目标轮次到来时，十二个信封同时打开，数字折叠成一个种子，种子把十二个名字排到模板上。

完整的论证，带图、不假设任何数学背景，在 [`docs/seating-design.zh.md`](docs/seating-design.zh.md)。构建会把它渲染进应用本身，所以选手从页眉打开的那一页就是这份文档。

## 保证了什么

|  | 怎么做到的 |
|---|---|
| **均匀** | 479,001,600 种分配每一种概率相等。 |
| **不可预测** | 一个诚实的贡献就够了。不需要多数，而且信标还叠加在上面。 |
| **不可偏置** | 任何人提交的那一刻，其他所有提交仍是密封的。选一个对自己有利的数字所需的信息还不存在——对任何人都不存在，包括组织者。 |
| **不可拖延** | 揭晓不是任何参与者执行的动作，所以「拒绝打开」这个选项不存在。 |
| **可核验** | 密封的密文、信标签名、打乱的代码和模板全部公开。`node generate.js --verify results.json` 逐字节复算。 |
| **无需信任** | 以上没有一条依赖于相信某个人行为诚实。 |

模板也不是启发式的：每一对选手恰好同桌三次、恰好对坐一次，每个位置的风位分布恰好是 {3,3,3,2}。这些数字全局最优且已证明——整数规划终止时目标值等于界。`python3 tools/verify_template.py data/schedule_template.json` 从轮次数据出发重新推导每一条。

## 文档

| 读 | 目的 | English |
|---|---|---|
| [`deploy/README.zh.md`](deploy/README.zh.md) | **办一场真实抽签**——一份指南，按顺序，从一台空服务器到活动结束 | [English](deploy/README.md) |
| [`docs/RUNBOOK.zh.md`](docs/RUNBOOK.zh.md) | 同一套流程压成一页清单，第二次办的时候用 | [English](docs/RUNBOOK.md) |
| [`docs/seating-design.zh.md`](docs/seating-design.zh.md) | 理解座位表，以及为什么一张已证明的表仍然需要一次抽签 | [English](docs/seating-design.md) |
| [`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) | 改代码——什么是冻结的、字节编码、API、人数门槛、信任边界 | [English](docs/PROTOCOL.md) |
| [`docs/UI-SPEC.zh.md`](docs/UI-SPEC.zh.md) | 面向选手的流程，一个阶段一个阶段 | [English](docs/UI-SPEC.md) |
| [`docs/PANTHEON-INTEGRATION.zh.md`](docs/PANTHEON-INTEGRATION.zh.md) | 线上格式，以及一个用来测试的本地 Pantheon | [English](docs/PANTHEON-INTEGRATION.md) |
| [`docs/IMPLEMENTATION_NOTES.zh.md`](docs/IMPLEMENTATION_NOTES.zh.md) | 代码为什么是这个样子，以及验证过什么 | [English](docs/IMPLEMENTATION_NOTES.md) |

## 办一场真实的抽签

组织者要做的一切都在 **[`deploy/README.zh.md`](deploy/README.zh.md)** 里，按顺序：Pantheon 里的活动、冻结、服务器、TLS、通告、开奖、收尾。它写成了从头到尾照着做、不用打开别的东西的样子。

## 开发

```sh
npm test                  # 446 个单元测试，离线，约 12 秒
npm run rehearse          # 组织者的完整流程，无界面，在沙盒里，约 3 分钟
npm run e2e               # 选手的完整流程，对着真实 drand，约 90 秒
npm run verify-template   # 重新推导座位模板的每一条不变量
```

CI（[`.github/workflows/reproducibility.yml`](.github/workflows/reproducibility.yml)）在 Linux 和开着 `core.autocrlf=true` 的 Windows 上、从一份未经触碰的克隆里跑测试、模板检查和 `node tools/build-client.js --check`——把已提交的 bundle 重新构建并比对。

对着进程内 Pantheon 替身的开发服务器：

```sh
npm run demo -- --keep                          # 最快的办法：留下一份配置齐全的副本
```

或者在这棵树里自己来，那需要一场活动：把 `data/protocol.example.json` 复制成 `data/protocol.json`，跑 `node tools/pick-round.js --in 2h --write`，让 `PANTHEON_STUB_ROSTER` 指向一份像 `tools/demo.js` 写的那样的报名文件，跑 `node tools/freeze.js --event <id> --write`，然后：

```sh
npm run build                                   # 从 client/ 构建 public/app.js + app.css
PANTHEON_MODE=stub npm run serve                # http://127.0.0.1:8080 ；--port 9000 换端口
ADMIN_TOKEN=x PANTHEON_MODE=stub npm run serve  # 外加组织者面板 /admin?token=x
```

`PANTHEON_MODE=stub` 同时启用一个不需要密码的登录替身，`NODE_ENV=production` 下会被拒绝。`data/runtime.json`（复制示例文件）装运营配置——drand 镜像、Pantheon 地址、代理——刻意放在冻结范围之外。

## 项目状态

| 部分 | 状态 |
|---|---|
| 座位模板及其证明 | **完成并验证**——全局最优，`tools/verify_template.py` 可重新推导 |
| `generate.js` 与字节编码 | **完成**——由一份独立的 Python 实现交叉核对 |
| 选手端应用 | **完成**——所有阶段、两种语言、含手机 |
| 后端、开奖任务及其调度 | **完成**——一个进程，不用 root，不用 cron |
| Pantheon 集成 | **完成**——对着两个真实实例跑过；[`docs/IMPLEMENTATION_NOTES.zh.md`](docs/IMPLEMENTATION_NOTES.zh.md) §6f 和 §10 |
| 运营流程 | **端到端彩排过**，并且真实部署过一次；第一场活动正在进行 |

## 仓库结构

```
generate.js                  # PROTOCOL §7 —— 冻结；只用 node:crypto，无依赖
data/
  schedule_template.json     # 冻结并已验证 —— 不要手改
  protocol.example.json      # 冻结参数：链、目标轮次、人数门槛、输入范围
  roster.example.json        # 形状参考；真正的那份由 tools/freeze.js 写出
  runtime.example.json       # 运营配置 —— 不冻结、不打 tag、可选
                             # protocol.json 和 roster.json 在这里被 gitignore：
                             # 它们是某一场活动的数据，冻结在办那场活动的那棵树里
server/
  server.js                  # API（PROTOCOL §6）和 SSE 流
  finalise.js                # 开奖任务和 Pantheon 同步 —— 一个单独的进程
  schedule.js                # 运行 finalise.js 的定时器，于是不需要 cron 或 systemd
  rounds.js                  # 作废的尝试：归档、验证、开启下一次
  admin.js                   # 组织者的只读面板
  pantheon.js                # Pantheon 边界：Twirp 客户端 + 进程内替身
  config.js  runtime.js      # 配置的冻结一半与运营一半
  ciphertext.js  drand.js  ots.js  tlock.js  db.js  events.js  mirror.js  stats.js
client/
  App.jsx  stages/  waiting/  explorer/  seal.js     # 选手的页面；seal.js 是封存数字的地方
public/
  app.js  app.css            # 构建出的 bundle —— 已提交，属于冻结范围
docs/                        # 每一份文档，旁边都有一份 .zh.md
deploy/
  README.md                  # 部署指南
  nginx.conf  nginx-bootstrap.conf  Caddyfile
  mahjong-relay.service  mahjong-relay.user.service
tools/
  demo.js                    # npm run demo：在这台机器上跑完整的一场抽签
  rehearse.js                # 组织者的流程，无界面，在沙盒里
  freeze.js                  # 快照名册、检查、提交、打 tag
  pick-round.js              # 目标轮次与截止时刻，保持一致
  check-signin.js            # 把一个账号的 Pantheon 登录逐步走一遍
  setup-mirror.js            # 镜像用的 GitHub token：取得、验证可写、写入配置
  new-round.js  end-event.js # 作废之后；活动之后
  build-client.js  md-to-page.js  verify-template.js  verify_template.py
  verify_contribution.py  decrypt-submissions.js  pantheon-fixture.js
test/                        # 单元测试，以及对着真实 drand 的 e2e.js
```

## 硬性规则

1. **不要手改 `data/schedule_template.json`。** 任何改动都会破坏已证明的性质。
2. **`roster.json`、`protocol.json`、`schedule_template.json` 和 `generate.js` 在提交开放之前一起冻结并打 git tag，在办活动的那个仓库里。** 此后改动任何一个字节都会使保证失效，整场重来。
3. **就这四个，别的都不冻结。** 一个参数在窗口中途改动能改变或引导结果，就是冻结的；否则就是运营的（[`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) §4.1）。
4. **人数门槛的规则也是冻结的**（[`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) §8）。真的出现 7/12 的时候，不重新商量。
5. **作废的尝试归档，绝不删除**，在 `events/rounds/<target_round>/` 下。
6. **选手提交的内容在揭晓之前绝不暴露。** 只有「是否提交了」，以及密封信封的指纹。
7. **同步到 Pantheon 时用 `WIND_SHUFFLE_MODE_PRESCRIPTED`。** 别的模式会重新随机风位，把模板优化出来的大部分东西扔掉。

## 许可证

MIT——见 [`LICENSE`](LICENSE)。`public/app.js` 是刻意提交的，因为封存选手数字的那个页面属于冻结所承诺的范围；编译进去的库连同它们的声明列在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 里，每次构建重新生成。
