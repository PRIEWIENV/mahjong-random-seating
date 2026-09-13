<div align="center">

# 随机麻将座位抽签

**面向十二人的座位抽签：没有人能预测，没有人能操纵，任何人事后都能自己验算——包括办这场抽签的人。**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2024-5FA04E?logo=node.js&logoColor=white)](package.json)
[![Tests](https://img.shields.io/badge/tests-432%20passing-brightgreen)](test/)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-1-informational)](package.json)
[![drand](https://img.shields.io/badge/randomness-drand%20quicknet-6f42c1)](https://drand.love)

[English](README.md) · 简体中文

</div>

---

十二位选手，十一轮，三张四人桌。座位**模板**——谁和谁同桌、坐什么风、在哪张桌子——是固定的，并且已被证明是最优的。至于哪位选手落到模板的哪个位置，则由一场抽签决定：十二人共同贡献，在预先宣布的时刻自行开启，任何愿意动手的人都能从公开数据复算出来。

两个部分彼此独立，而且都已完成：组合学部分求解到了可证最优，抽签部分是一个可运行的 Web 应用，配有成文的协议、运营手册，以及一套三分钟就能跑完的端到端排练。

**目录** — [工作原理](#工作原理) · [保证了什么](#保证了什么) ·
[从哪里开始](#从哪里开始) · [文档](#文档) ·
[如何运行](#如何运行) · [项目状态](#项目状态) ·
[仓库结构](#仓库结构) · [硬性规则](#硬性规则) ·
[许可证](#许可证)

## 工作原理

```mermaid
flowchart LR
  A["每位选手封存<br/>一个数字，只封一次"] --> B["密文一到达<br/>就公开"]
  B --> C["截止：提交名单<br/>固定并打上时间戳"]
  C --> D["drand 信标走到<br/>目标轮次"]
  D --> E["所有信封<br/>同时打开"]
  E --> F["种子把名字洗到<br/>已证明最优的模板上"]
  F --> G["座位表，<br/>任何人都能复算"]
```

每位选手挑一个 0 到 255 之间的整数。他的浏览器把这个数字与自己生成的十六字节随机值混合，再用**时间锁加密**封给未来某个 [drand](https://drand.love) 信标轮次——于是这份密文在事先定好的那一刻变得可读，早一秒都不行。没有可以收买、传唤或者必须信任的持钥人：提前打开不是被禁止，而是做不到。

每一份密文在到达的那一刻就被公开，并带上第三方的时间戳。到截止时刻，参与名单被固定、取摘要，并通过 [OpenTimestamps](https://opentimestamps.org) 锚进比特币——而此时能打开其中任何一份的信标仍然不存在。目标轮次到达时，十二个信封同时打开，数字合成一个种子，种子把十二个名字排列到模板上。

想看从第一性原理出发的完整论证（带插图），读 **[`docs/seating-design.zh.md`](docs/seating-design.zh.md)**。它不只是文档：构建过程会把它和它的英文原版渲染进应用本身，所以选手从页头点开的那一页，就是这个仓库里的这份文档，而不是一份可能与之脱节的摘要。

## 保证了什么

|  | 怎么做到的 |
|---|---|
| **均匀** | 479,001,600 种分配方式等概率。 |
| **不可预测** | 一份诚实的贡献就够了。不需要多数，而且信标还会在最后折进来。 |
| **不可操纵** | 在任何人提交的那一刻，其余每一份提交都还封着。挑一个有利数字所需的信息此时尚不存在——对任何人都不存在，组织者也一样。 |
| **不可拖延** | 「打开」不是任何参与者执行的动作，所以「拒绝打开」这个选项根本不存在。 |
| **可验证** | 封存的密文、信标签名、洗牌代码和模板全部公开。`node generate.js --verify results.json` 会把每一个字节重算一遍。 |
| **无需信任** | 以上没有一条建立在「相信某个人是诚实的」之上。 |

座位模板本身也不是启发式凑出来的。任意两人恰好同桌三次；每个位置的风位分布恰好是 {3,3,3,2}；任意两人恰好对坐一次；66 对关系里有 55 对完全平衡。这些数字是**全局最优且已证明的**——整数规划以目标值等于界的方式终止，搜索覆盖了已知存在的全部五个互不同构的可分解 2-(12,4,3) 设计，其中恰好只有一个能满足「对坐一次」的条件。这个设计不是被选中的，而是被迫的。

## 从哪里开始

### 先看它跑起来

```sh
git clone <本仓库> && cd mahjong-random-seating
npm ci
npm test                  # 432 个单元测试，离线，约 12 秒
npm run rehearse          # 沙箱里端到端跑完整场抽签，约 3 分钟
```

`npm run rehearse` 会建一个用完即弃的 git 仓库，快照名册，冻结并打 tag，对着三分钟后的一个真实 drand 轮次封存十二份真密文，跑完抽签，同步座位表，并执行选手事后会做的那项核验。只有 Pantheon 是模拟的。不需要账号，不需要配置，不需要 `.env`。

### 改代码

1. 先读 [`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md)。它界定了一处改动被允许影响什么。
2. 按下面的[开发](#开发)一节搭起开发循环。`PANTHEON_MODE=stub` 不需要任何 Pantheon 部署。
3. 按需查阅：选手看得见的流程查 [`UI-SPEC.zh.md`](docs/UI-SPEC.zh.md)，线上格式查 [`PANTHEON-INTEGRATION.zh.md`](docs/PANTHEON-INTEGRATION.zh.md)，代码为什么这样写查 [`IMPLEMENTATION_NOTES.zh.md`](docs/IMPLEMENTATION_NOTES.zh.md)。

### 真的办一场抽签

```
npm run rehearse ─▶ RUNBOOK A ─▶ RUNBOOK B ─▶ deploy/README ─▶ RUNBOOK C ─▶ D ─▶ E
```

部署是 runbook 里的一步，不是一份并列的文档。RUNBOOK 第 11 步推出一个 tag，[`deploy/README.zh.md`](deploy/README.zh.md) §1 检出它。正是那个 tag 把 `data/protocol.json` 和 `data/roster.json` 放进仓库，所以它不存在时没有任何东西可以安装。

1. 先跑一次 `npm run rehearse`，在沙箱里看一遍整个序列。
2. 把 [`docs/RUNBOOK.zh.md`](docs/RUNBOOK.zh.md) 从头读到尾。带锁标记的步骤进入冻结状态，此后任何东西都不得再修改。
3. **RUNBOOK A** —— 用一场测试活动和十二个虚拟账号把整条路走一遍。[`PANTHEON-INTEGRATION.zh.md`](docs/PANTHEON-INTEGRATION.zh.md) §6 讲怎么把实例搭起来。
4. **RUNBOOK B 第 8 到 11 步** —— 登记十二个人、选定目标轮次、冻结并打 tag。这一步在开发机上做：冻结会从源码重建浏览器 bundle，服务器上没有那套工具链。
5. **[`deploy/README.zh.md`](deploy/README.zh.md)** —— 在那个 tag 上安装、写 `.env`、架好反向代理和 TLS，跑它的 §5 起飞前检查。
6. **RUNBOOK C 和 D** —— 给选手发同一个链接，盯着提交数，然后确认开奖跑过了、座位表也进了 Pantheon。
7. **RUNBOOK E** —— 在冻结下一场之前把这一场收尾。

## 文档

按阅读顺序排列。没有哪一条路需要七份都读。

| 文档 | 内容 | English |
|---|---|---|
| [`docs/seating-design.zh.md`](docs/seating-design.zh.md) | 座位表：愿望清单、两条不可能性定理、求解器，以及一张已证明最优的表为什么仍然需要抽签。不需要数学背景。 | [English](docs/seating-design.md) |
| [`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) | 冻结产物、字节编码、API、门槛与失败处理、信任边界。**改代码之前先读。** | [English](docs/PROTOCOL.md) |
| [`docs/RUNBOOK.zh.md`](docs/RUNBOOK.zh.md) | 运营者的检查清单，按顺序：实现、冻结、提交窗口、开奖、收尾。**真的办一场之前先读。** | [English](docs/RUNBOOK.md) |
| [`deploy/README.zh.md`](deploy/README.zh.md) | 安装、环境变量、进程管理、反向代理、TLS，以及公布 URL 之前的起飞前检查。排在 RUNBOOK 第 11 步之后。 | [English](deploy/README.md) |
| [`docs/PANTHEON-INTEGRATION.zh.md`](docs/PANTHEON-INTEGRATION.zh.md) | 通过 Frey 登录、通过 Mimir 写回座位表、线上格式，以及一个可供测试的本地实例。 | [English](docs/PANTHEON-INTEGRATION.md) |
| [`docs/UI-SPEC.zh.md`](docs/UI-SPEC.zh.md) | 面向选手的流程，逐个阶段，以及那些让它保持诚实的规则。 | [English](docs/UI-SPEC.md) |
| [`docs/IMPLEMENTATION_NOTES.zh.md`](docs/IMPLEMENTATION_NOTES.zh.md) | 规范留白处的每一个决定、每一处偏离、值得知道的 bug，以及一张「到底验证了什么」的表。 | [English](docs/IMPLEMENTATION_NOTES.md) |

## 如何运行

### 检查

```sh
npm ci
npm test                  # 432 个单元测试，离线，约 12 秒
npm run verify-template   # 重新推导冻结模板的每一条不变量
npm run e2e               # 对着真实 drand 跑 RUNBOOK A2-A7，约 90 秒
npm run rehearse          # 沙箱里端到端跑完 RUNBOOK B/C/D，约 3 分钟
```

[`.github/workflows/reproducibility.yml`](.github/workflows/reproducibility.yml) 在每次 push 时跑前三项，Linux 一遍，开了 `core.autocrlf=true` 的 Windows 再一遍，另加 `build-client.js --check`——从源码重建的检查，`--verify-hash` 顶替不了，因为它需要 esbuild。它刻意跑在一份没人碰过的克隆上：[`IMPLEMENTATION_NOTES.zh.md`](docs/IMPLEMENTATION_NOTES.zh.md) §6d 里那个检出 bug，在写出这些文件的那棵树里不可能出现。`e2e` 不在其中，它要连真实 drand，要三分钟。

### 开发

应用需要 `data/protocol.json` 和 `data/roster.json`，没有就拒绝启动。把 `.example` 文件改个名是不行的，而且这是故意的：占位值 `target_round: 0` 和 `pantheon_event_id: 0` 都会被拒绝，所以没法用一组谁也没选过的参数把抽签跑起来。

```sh
cp data/protocol.example.json data/protocol.json
node tools/pick-round.js --in 2h --write        # 目标轮次、截止时刻和开奖间隔一起定下
node tools/freeze.js --event 42 --write         # data/roster.json，从 Pantheon 读出来
npm run build                                   # 重建 public/app.js + app.css
PANTHEON_MODE=stub npm run serve                # http://127.0.0.1:8080
```

> [!IMPORTANT]
> **名册不用手打。** `tools/freeze.js --event <id> --write` 从 Pantheon 读出这场活动的报名信息，自己写出十二行 `{local_id, person_id, title}`，并把标了 `ignore_seating` 的人排除在外。只要有任何一位选手没有 `local_id`，它就什么都不写——那个错误否则要等到开奖之后、座位表同步的时候才浮现，而那时什么都改不了了。不加 `--write` 时它只说自己打算做什么，不碰任何文件。这是 RUNBOOK 第 10 步，也是生成那个文件的唯一受支持方式。

开发需要一个可读的 Pantheon，有三条路：

- **一个真实实例** —— `PANTHEON_MODE=twirp`，加上 [`deploy/README.zh.md`](deploy/README.zh.md) §2 里的基础 URL 和管理员凭证。`tools/pantheon-fixture.js --accounts` 会在上面建好一场测试活动，连十二个账号一起。
- **完全没有 Pantheon** —— `PANTHEON_MODE=stub`，用 `PANTHEON_STUB_ROSTER` 指向一个小的报名 JSON 文件。这个桩不从 `roster.json` 自举：一个和第 10 步本该写出的文件完全一致的假实现，检验不了第 10 步。它回答活动名称查询时给的是 `Stub event <id>`，可用 `PANTHEON_STUB_EVENT_TITLE` 覆盖。
- **暂时两样都没有** —— `npm run rehearse` 会在一个用完即弃的仓库里跑完 B、C、D 全部内容，包括这一步和它的各种拒绝。

<details>
<summary><b>选端口、管理面板，以及 <code>runtime.json</code></b></summary>

<br>

8080 是默认端口，而且经常被占，尤其是在同时跑着 Pantheon 的机器上。两种写法都行，命令行参数优先：

```sh
node server/server.js --port 9000
PORT=9000 npm run serve
```

`--host` 用同样的方式改监听接口；不显式指定的话它只在回环地址上，因为生产环境里 TLS 是由前面的东西终结的。端口已被占用会被报成「端口已被占用」，并告诉你改用哪个参数，而不是甩一段栈回溯。

`PANTHEON_MODE=stub` 跑的是进程内的假实现，正是它让整条流程在没有 Pantheon 部署的情况下也能走通。它同时会启用一个仅限开发的登录替身，该替身在 `NODE_ENV=production` 下会被拒绝。

设置 `ADMIN_TOKEN` 就能在 `/admin?token=…` 打开组织者面板：提交进度和还差谁、起飞前检查、冻结产物的指纹、开奖任务是否在跑、结果、Pantheon 同步状态，以及过去每一次尝试。它是只读的，没有 `ADMIN_TOKEN` 时这条路由根本不存在。

```sh
ADMIN_TOKEN=$(openssl rand -hex 16) PANTHEON_MODE=stub npm run serve
```

`data/runtime.json` 是可选的。只有在要改点什么的时候才把 `runtime.example.json` 复制过去——换一个 drand 镜像、填真实的 Pantheon 基础 URL 之类。注意它被 gitignore 了，因为它被刻意放在冻结范围之外（[`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) §4.2）。

</details>

### 生产

两份文档，有先后：[`docs/RUNBOOK.zh.md`](docs/RUNBOOK.zh.md) 管这场活动，[`deploy/README.zh.md`](deploy/README.zh.md) 管服务器。见上面的[真的办一场抽签](#真的办一场抽签)。下面写的是这个进程本身的细节。

一个进程，既服务页面也负责开奖：

```sh
node server/server.js
```

这就是整个部署。进程启动时读取 checkout 根目录下的 `.env`，并在最初几行日志里报出它读了哪个文件。所有让一次部署成为真部署而不是演示的东西都在那里面：Pantheon 的基础 URL、用于座位同步的管理员账号、镜像仓库和它的 token、`ADMIN_TOKEN`、`NODE_ENV=production`。文件内容见 [`deploy/README.zh.md`](deploy/README.zh.md) §2。

没有别的东西要装，也不需要 root：进程不需要，熬过重启不需要，安装它也不需要。服务器用自己的定时器派生 `server/finalise.js`（`server.finalise_interval_seconds`，默认 60 秒），所以开奖不需要 systemd 单元也不需要 cron 条目；把 `server.run_finalise` 设为 `false` 可以把调度交还给你。

冻结检出、`.env`、反向代理与 TLS、在 Linux 或 Windows 上守住这一个进程，以及万一没人开奖怎么发现，都在 **[`deploy/README.zh.md`](deploy/README.zh.md)** 里。

和上面开发命令的三处差别，每一处都可能让你把测试当成真事在跑：

| | 开发 | 生产 |
|---|---|---|
| `NODE_ENV` | 不设置 | `production` —— 会话 cookie 标上 `Secure`，并让 `/api/dev-authorize` 返回 404 |
| `PANTHEON_MODE` | `stub` | `twirp`，指向选手真正有账号的那个实例 |
| 冻结 | 树里是什么就是什么 | 检出到 RUNBOOK 第 11 步的那个 tag，且 `--verify-hash` 通过 |

`/admin` 会在起飞前面板里报出这三条，只要有一条不对就拒绝把这次部署判为就绪。

```sh
node tools/freeze.js                            # RUNBOOK 8-11，只检查
node tools/freeze.js --write --tag <name>       # ……并提交、打 tag
```

## 项目状态

| 部分 | 状态 |
|---|---|
| 座位模板及其证明 | **已完成并验证** —— 全局最优，可由 `tools/verify_template.py` 重新推导 |
| `generate.js` 与字节编码 | **已完成** —— 由一份独立的 Python 实现交叉校验 |
| 选手端应用 | **已完成** —— 全部阶段、两种语言，含手机端（[`docs/UI-SPEC.zh.md`](docs/UI-SPEC.zh.md)） |
| 后端、开奖任务及其调度 | **已完成** —— 一个进程，不要 root，不要 cron |
| Pantheon 集成 | **已完成，并对着真实实例跑过** —— 见下 |
| 运营手册 | **排练过，未实战** |
| 一场当事人不知道是测试的抽签 | **还没有** |

<details>
<summary><b>「对着真实实例跑过」是什么意思，不是什么意思</b></summary>

<br>

Twirp 客户端已经对着一个真实 Pantheon（`cdda3fc`，WSL 2 下的 Docker）跑过两次：一次借用现成活动，一次是端到端的新活动——十二位选手全部用邮箱和密码登录（`tools/pantheon-fixture.js --accounts`），封存真实密文，最后把生成的座位表从 Pantheon 里一个座位一个座位读回来核对。两轮下来一共有九处不对，而且没有一处是大声失败的——见 [`docs/PANTHEON-INTEGRATION.zh.md`](docs/PANTHEON-INTEGRATION.zh.md) §2、§3、§5.1 和 §6。

其中三处在部署前值得知道：Frey 需要**两个**地址，因为浏览器也要直接调它，不只是后端；登录失败无论什么原因，过去都被报给选手为「密码错误」；以及 `MakePrescriptedSeating` 在调用方不明确指定模式时会把风位重新随机——Forseti 会指定，而脚本可能不会。

还没关掉的那一项范围更窄：**你实际部署的那个实例**。Pantheon 在演进，§5.1 是关于某一个 commit 的事实；有了 fixture 和 §6，重新核对是半小时的活，不是一项研究课题。

</details>

<details>
<summary><b>「排练过，未实战」是什么意思</b></summary>

<br>

`npm run rehearse` 在一个用完即弃的仓库里端到端跑完手册的 B、C、D 三节——名册快照、冻结、打 tag、十二份封存的提交、催缴名单、开奖、同步，以及选手事后会做的核验——对手是 Pantheon 桩和一个真实 drand 轮次。每一步都通过。剩下的是为一场真实活动做一遍：真实报名、真实部署，并把桩换成真实实例。

表里最后一行是唯一一项无法靠多写代码关掉的。

</details>

> [!WARNING]
> 冻结之前先读 [`docs/IMPLEMENTATION_NOTES.zh.md`](docs/IMPLEMENTATION_NOTES.zh.md)；改代码之前把 [`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) 从头到尾读完，尤其是 §7（算法）和 §8（门槛与失败处理）。公平性就是从那些规则里来的，不应该因为当下觉得哪种做法更合理就把它们改掉。

## 仓库结构

```
generate.js                  # PROTOCOL.md §7 —— 冻结；只用 node:crypto，无依赖
data/
  schedule_template.json     # 已冻结并验证 —— 不要手工编辑
  roster.example.json        # 形状参考；真正那份由 tools/freeze.js 写出
  protocol.example.json      # 冻结参数：链、目标轮次、门槛、输入范围
  runtime.example.json       # 运营配置 —— 不冻结、不打 tag、可选
                             # protocol.json 和 roster.json 在本仓库被 gitignore：
                             # 它们是一次活动的数据，在跑那场活动的树里冻结
server/
  server.js                  # §6 的六个端点，外加 SSE 流
  finalise.js                # 开奖任务和 Pantheon 同步（§5、§8）—— 独立进程，
                             # 由 schedule.js 定时拉起
                             # 幂等：从不重复开奖，也从不撤回已发布的结果
  schedule.js                # 拉起 finalise.js 的定时器，因此不需要 cron 或 systemd
  rounds.js                  # 作废的尝试：归档、验证，并开启下一次
  admin.js                   # 组织者的只读面板（RUNBOOK C/D）
  pantheon.js                # Pantheon 边界：Twirp 客户端 + 进程内桩
  config.js                  # 加载并校验冻结产物；不合格就拒绝启动
  runtime.js                 # 另一半：运营配置及其默认值（§4.2）
  ciphertext.js              # 准入检查 —— 这份密文是不是封给我们这条链、这一轮的？
  stats.js                   # 座位表浏览器用的逐人统计（UI-SPEC §7）
  drand.js                   # 多镜像信标客户端；镜像之间不一致就拒绝开奖
  ots.js                     # OpenTimestamps 写入器，零依赖（§9 锚定）
  tlock.js  db.js  events.js  mirror.js
client/
  App.jsx                    # 阶段状态机（UI-SPEC §2）
  stages/                    # signin、submit、submitted、waiting、revealing、void、result
  waiting/                   # 时间轴和十二个信封
  explorer/                  # 座位表：总表、单人视角、单轮视角
  Doc.jsx                    # 原理详情页，来自 docs/seating-design*.md
  RollCard.jsx               # 封存的密文、其摘要及时间戳证明
  seal.js                    # 构造并封存 {user_input, client_nonce, client_timestamp}
  generated/                 # design-doc.js，由构建写出 —— 不提交
public/
  app.js  app.css            # 构建产物 —— 提交，属于冻结范围
  figures/                   # 构建时从 docs/figures 复制；提交，但不在冻结摘要内
LICENSE                      # MIT
THIRD-PARTY-NOTICES.md       # bundle 里那些库的许可声明；由构建写出
docs/
  seating-design.md          # 原理说明，会被渲染进应用（UI-SPEC §10）
  PROTOCOL.md  PANTHEON-INTEGRATION.md  UI-SPEC.md  RUNBOOK.md
  IMPLEMENTATION_NOTES.md    # 决定、偏离，以及哪些还没验证
                             # 以上每一份旁边都有一份 .zh.md
tools/
  verify_template.py         # 重新推导模板的每一条不变量
  verify_contribution.py     # 字节编码的第二份实现，换一种语言写的
  build-client.js            # 构建浏览器 bundle 并固定其哈希
  md-to-page.js              # 把 seating-design*.md 渲染成原理详情页
  verify-template.js         # 和 Python 那份同样的不变量，供冻结流程使用
  pick-round.js              # 目标轮次与截止时刻，保持一致
  new-round.js               # 作废之后：验证归档，再开启下一次尝试
  end-event.js               # 活动结束之后：归档，再清理 var/ 和 events/
  freeze.js                  # 把 RUNBOOK 8-11 合成一条命令：快照、检查、提交、打 tag
  rehearse.js                # 在沙箱里端到端跑 RUNBOOK B/C/D，在正日子之前
  pantheon-fixture.js        # 在本地 Pantheon 上搭好测试活动（仅限开发）
  check-signin.js            # 在任何机器上，把一个账号的 Pantheon 登录逐步走一遍
  decrypt-submissions.js     # 参与者一侧的验证
test/
  *.test.js                  # 单元测试，含对着快照的点名核对
  e2e.js                     # 对着真实 drand 跑 RUNBOOK A2-A7
deploy/
  nginx.conf、Caddyfile、mahjong-relay.service（可选）、README.md
```

## 硬性规则

1. **不要手工编辑 `data/schedule_template.json`。** 任何改动都会破坏已证明的性质。如果非改不可，重新跑 `tools/verify_template.py`，并从头重做冻结。
2. **`roster.json`、`protocol.json`、`schedule_template.json` 和 `generate.js` 在提交开放之前一起冻结并打 git tag，在跑这场活动的那个仓库里。** 此后哪怕改一个字节，保证就失效，这一轮要重来。前两个在本仓库被刻意 gitignore——它们是一次活动的数据，`tools/freeze.js` 会在那场活动所属的树里用 `-f` 强制加进去。
3. **就这四个，别的都不冻。** 判据是：如果在窗口期内改动它可能改变或操纵结果，它就是冻结参数，否则就是运营配置（[`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) §4.1）。冻得比这更多不是更谨慎：那意味着组织者迟早会有一个正当理由去编辑一个已打 tag 的文件，而冻结存在的目的正是防止养成这个习惯。
4. **门槛规则同样是冻结的**（[`docs/PROTOCOL.zh.md`](docs/PROTOCOL.zh.md) §8）。真的出现 12 人里只到 7 人的情况时，它不能被重新商量——事后再决定本身就是一个可操纵的步骤。
5. **作废的尝试只归档，不删除。** 它的全部密文、截止时的提交名单，以及它当时运行所依据的 `protocol.json`，都会发布在 `events/rounds/<target_round>/` 下，好让任何人都能确认这一轮确实没达到门槛。开启下一次尝试必须先重新冻结，而只要归档验证不通过，`tools/new-round.js` 就拒绝执行。
6. **选手提交了什么，在开奖之前永远不会暴露。** 只公开他是否提交了，以及那个封存信封的指纹——而指纹是对一份本已公开的密文取的摘要，打不开任何东西。
7. **同步到 Pantheon 时必须用 `WIND_SHUFFLE_MODE_PRESCRIPTED`。** 任何其他模式都会把风位重新随机，把模板优化出来的东西丢掉大半。

## 自己核验模板

```sh
python3 tools/verify_template.py data/schedule_template.json
```

它从轮次数据重新推导每一条不变量，而不是相信文件自带的 `verified_properties` 块；只要有任何一条对不上就以非零码退出。可以放心交给想自己核验模板的参与者。`npm run verify-template` 是同一套不变量的 JavaScript 版本，冻结流程跑的就是它。

## 许可证

MIT —— 见 [`LICENSE`](LICENSE)。

`public/app.js` 是构建产物，而它被刻意提交进仓库，因为封存选手数字的那一页属于冻结所承诺的范围。这使得本仓库成为编译进那个 bundle 的十七个库的一次二进制分发，所以它们的许可声明被复制在
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 里——该文件在每次构建时依据 esbuild 自己记录的「到底放进去了什么」重新生成，因此不会落后于后来新增的依赖。

`generate.js` 和 `data/schedule_template.json` 本来就是给人拷走、重跑、挑刺用的。公开它们就是为了这个。
