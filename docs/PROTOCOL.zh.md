# 随机座位协议（tlock 版）

> [English](PROTOCOL.md) · 简体中文

实现规范。一旦达成一致，四份产物——`protocol.json`、`roster.json`、`schedule_template.json` 和 `generate.js`——在提交开放**之前**一起冻结并打上 git tag。冻结之后，其中任何一份改动一个字节，公平性保证即告失效，这一轮必须重来。

恰好四份，不多。运营配置——今天哪个 drand 镜像连得上、Pantheon 在这台机器的哪个位置、会话 cookie 活多久——被刻意排除在冻结之外，放在 `runtime.json` 里。§4.1 给出判断某个参数该落在哪一侧的判据，以及为什么把这条线画得太宽是在削弱冻结而不是加强它。

配套文档：[`PANTHEON-INTEGRATION.zh.md`](PANTHEON-INTEGRATION.zh.md) 讲登录与座位表同步，[`UI-SPEC.zh.md`](UI-SPEC.zh.md) 讲选手端流程，[`seating-design.zh.md`](seating-design.zh.md) 讲模板本身背后的推理。

## 1. 概览

- **目标。** 把十二位已知选手映射到一份固定的、已证明最优的座位模板的十二个抽象位置上。这个映射由所有人共同贡献的随机性决定，任何单一方——包括运行服务器的人——都无法预测或操纵。
- **机制。** 时间锁加密（tlock，建立在 drand 公共随机信标之上）。每位选手登录、输入一个 0 到 255 之间的数字、提交，然后就结束了：不用再来第二次，不用一直开着标签页，也不会向他暴露什么「阶段」的概念。
- **身份。** 选手用已有的 Pantheon 账号登录。只有报名了指定活动的账号才能登录。
- **门槛。** 到目标轮次时，如果十二人中**至少有 8 人（三分之二）**提交了，抽签照常进行。低于此数则本轮作废，所有人对着新的目标轮次重新提交。
- **输出。** 最终座位表在应用里展示，并作为活动的 prescripted seating 写进 Pantheon。

## 2. 角色

| 参与方 | 做什么 | 必须在什么事上被信任 |
|---|---|---|
| 选手（12 人） | 登录，输入一个数字，提交 | 无 |
| 组织者 | 冻结产物，运行服务器，持有用于同步的 Pantheon 管理员账号 | 关于抽签本身：无 |
| 服务器（VPS） | 校验登录，存储密文，按时开奖，同步到 Pantheon | 无 —— 它持有的每一份密文都可以安全公开 |
| Pantheon | 提供身份和活动名册；接收最终座位表 | 正确报告谁报名了这场活动 |
| drand（quicknet） | 发布打开信封的信标值 | 目标轮次时的可用性 |

## 3. 每位选手贡献什么

每位选手输入一个 `0 … 255` 之间的整数——一个小的、人的尺度的数字，是人们真正乐意去挑的那种。被封存的不是这个数字本身，而是一小段载荷：

```
{ user_input, client_nonce, client_timestamp }
```

`client_nonce` 是 `crypto.getRandomValues` 给出的 16 字节；`client_timestamp` 是提交那一刻浏览器的 ISO-8601 时间。两者都封在信封里，所以两者都会在开奖时变成公开的，下面的每一步任何人都能复算。

选手的贡献是**完整、未截断**的 256 位哈希

```
contribution_i = SHA256(DOMAIN ‖ "contrib" ‖ local_id ‖ user_input ‖ client_nonce ‖ client_timestamp)
```

合并值是全部贡献的异或：

```
R = contribution_1 XOR … XOR contribution_n      // 256 位
```

### 3.1 为什么这样设计

**先哈希，后异或。** 异或不会跨位混合。如果贡献就是原始数字，而每个人都挑了个小数——人就是这么干的——那么每份贡献的高位都是零，它们的异或也是：无论字段声明得多宽，结果都会在结构上被困在一个极小的子空间里。哈希把任意输入摊到全部 256 位上，所以 `7` 和 `8` 产生两个互不相关、分布良好的值。它还让熵可以**累加**：原始小整数把熵困在低位，而哈希过的贡献表现得像独立均匀值，于是十二个人各自只提供几比特的真实选择，合起来就把整个宽度填满了。

**nonce 承担人做不到的那部分熵。** 不应该要求任何人手工产生 256 位随机数，而一个打了 `7` 的选手也不该削弱这场抽签。把 nonce 放进哈希，无论选手打了什么，每份贡献都是均匀分布的。信任假设从「十二个人里至少有一个是随机选的」降到「至少有一个浏览器的 CSPRNG 是好的」，后者可靠得多。选手自己的选择仍然可证地进入了结果：nonce 会和其他一切一起被揭示，所以任何人都能重算 `SHA256(… ‖ user_input ‖ client_nonce ‖ …)`，确认这位选手的数字确实在里面。

**时间戳是白捡的可变性。** 它不需要可信。一个在时钟上撒谎的客户端只是改变了自己的贡献——而它打一个不同的数字同样能做到——所以没有任何东西依赖它。

**人的那部分 8 位就够了。** 因为哈希和 nonce 承担了工作，所输入数字的大小不再限制结果空间。一个 0 到 255 之间的数字好挑、好记，事后也好核对。

目标轮次的 drand 签名同样被折进种子（§7）。它在那一轮之前不可预测，而且由于 BLS 签名对给定的轮次和密钥是唯一的，它无法被穷举——哪怕信标被攻破也不行。它不花任何代价，却意味着这场抽签不只依赖那十二个浏览器。

## 4. 冻结产物

四个文件在提交开放之前一起冻结并打 git tag：`roster.json`、`protocol.json`、`schedule_template.json` 和 `generate.js`。

在**运营者的**仓库里。任何人都可以用这份代码办自己的活动，所以承诺是在活动被运行的地方做出的，不是在代码被写出来的地方：`roster.json` 和 `protocol.json` 在源码树里被 gitignore，`tools/freeze.js` 用 `-f` 把它们加进去。把开发者的测试活动提交到上游，等于公开十二个真实的 Pantheon id，而且对谁都证明不了任何事。

### 4.1 什么该进冻结

一条判据决定：

> 在提交开放之后改动这个值，是否可能改变结果，或者让某人得以操纵结果？

**是**——它是冻结的，属于 `protocol.json`。**否**——它是运营配置，属于 `runtime.json`，而那个文件刻意**不在** tag 里。

这个划分不是为了整洁。把一个通不过判据的东西冻结，只会让这一轮更脆弱，却一点也不更公平。假如 `drand_api` 被冻结，而那个镜像在提交窗口期间挂了，协议内唯一的补救就是作废本轮——为了一次根本不可能影响结果的故障，因为链由 `chain_hash` 和 `chain_public_key` 钉死，每个信标签名都要对着那个公钥验证。而一个组织者有正当运营理由去编辑的冻结文件，就是选手迟早会被要求接受一次编辑的文件，而这正是冻结要防止的习惯。

**`roster.json`** —— 冻结时刻对 Pantheon 活动名册的快照。
```
{
  "pantheon_event_id": 42,
  "players": [
    { "local_id": 1, "person_id": 1234, "title": "Alice" },
    ... 恰好 12 条
  ]
}
```
`local_id` 是 Pantheon 的每活动选手编号，也是座位表同步写回去的东西（见 `PANTHEON-INTEGRATION.zh.md`）。`person_id` 是全局 Pantheon 账号 id，是已登录会话据以匹配的东西。冻结这份名单意味着提交一旦开放，任何人都不能被加入、移除或替换。`local_id` 必须落在 `1 … 255` 之内，因为 §7 把它编码为一个字节。

**`protocol.json`** —— 冻结参数，别的什么都没有。
```
{
  "drand_chain": "quicknet",
  "chain_hash": "<64 位十六进制 —— drand quicknet 的链哈希>",
  "chain_public_key": "<96 或 192 位十六进制 —— 同一条链的群公钥>",
  "target_round": 123456,
  "target_round_utc": "2026-09-10T20:10:00Z",
  "submission_cutoff_utc": "2026-09-10T20:00:00Z",
  "reveal_gap_seconds": 600,
  "quorum": 8,
  "total_slots": 12,
  "user_input_max": 255,
  "seed_domain_separation": "mahjong-seating-v1",
  "schedule_template_ref": "data/schedule_template.json@<git tag>",
  "generate_script_ref": "generate.js@<git tag>",
  "pantheon": { "wind_shuffle_mode": "WIND_SHUFFLE_MODE_PRESCRIPTED" }
}
```

| 字段 | 为什么冻结 |
|---|---|
| `drand_chain`、`chain_hash`、`chain_public_key` | 标识信封封给哪条信标链。换掉链就换掉了随机性。 |
| `target_round` | 信封什么时候打开。往前挪就是提前打开。 |
| `target_round_utc` | 同一时刻的时间表示，好让下面那个间隔不用问网络就能检查。任务运行时会与链交叉核对。 |
| `submission_cutoff_utc` | 快照边界（§8）。挪动它就改变了谁被计入。 |
| `reveal_gap_seconds` | 提交名单在密钥存在之前被固定多久，默认十分钟。缩短它就压缩了那份名单可以被发布和锚定的窗口，缩到零就完全没有窗口——而那正是迟交可以被伪造的原因（§9）。 |
| `quorum`、`total_slots` | §8 的规则，在任何人能看出谁没交之前就定下。 |
| `user_input_max` | 每位选手取值的域，也是贡献哈希里的一个字节。 |
| `seed_domain_separation` | §7 里的 `DOMAIN`。改它，抽签里每一个哈希都变。 |
| `schedule_template_ref`、`generate_script_ref` | 指明另外两份产物来自哪个 tag，让四个文件互相承诺。 |
| `pantheon.wind_shuffle_mode` | 除 `WIND_SHUFFLE_MODE_PRESCRIPTED` 之外的任何模式都会在桌上重新随机风位，把模板保证的东西丢掉大半（硬性规则 5）。 |

**`chain_public_key` 是必需的，而且是在 `chain_hash` 之外**另外**必需，不是取而代之。** `drand-client` 在 `isValidInfo` 里判断自己是否在跟正确的链说话，它同时比对哈希**和**公钥，两个都要。只钉哈希的话 `publicKey` 就是 `undefined`，比对对任何一条真实的链都失败，于是最省力的路径就变成了关掉链验证——让客户端相信端点自称的任何身份。冻结时从 `<drand api>/<chain_hash>/info`（`runtime.json` → `drand.api`）读一次这个公钥，和哈希记在一起。它之所以冻结，是因为它是「这场抽签绑定在哪个随机源上」这个问题的另一半答案。

**`schedule_template.json`** —— 建立在十二个抽象点上的参考模板，已导出并经独立复核。它的结构和不变量记录在 `seating-design.zh.md` 里；`tools/verify_template.py` 从数据把每一条重新推导一遍。

### 4.2 `runtime.json` —— 运营配置，不冻结，不打 tag

```
{
  "drand": {
    "api": "https://api.drand.sh",
    "mirrors": ["https://api.drand.sh", "https://api2.drand.sh",
                "https://api3.drand.sh", "https://drand.cloudflare.com"],
    "health_poll_ms": 30000
  },
  "pantheon": {
    "frey_base_url": "http://localhost:4001",
    "mimir_base_url": "http://localhost:4002",
    "twirp_path_template": "/twirp/{service}/{method}",
    "frey_service": "frey.Frey",
    "mimir_service": "mimir.Mimir",
    "event_title": null
  },
  "ui":     { "status_poll_interval_ms": 15000 },
  "server": { "sse_heartbeat_ms": 25000, "session_ttl_days": 30, "rate_limit_per_minute": 30,
              "trust_proxy": false, "run_finalise": true, "finalise_interval_seconds": 60 }
}
```

`trust_proxy` 值得说一句，因为它的默认值对 §10 描述的那种部署是错的，对其他所有地方是对的。限流是按来源地址算的，而在反向代理后面每个请求都来自 127.0.0.1——于是限额变成十二个人共享的一份。打开它之后服务器改读 `X-Forwarded-For`，取**最右边**那一项，也就是代理自己观察到的地址，而不是调用方可以随口声称的任何东西。默认关闭，是因为一台前面什么都没有的服务器否则会给每一个编造出来的地址发一份限额。

这个文件是可选的，里面每个键也是；缺失的任何东西都回落到上面展示的默认值，也就是编译进 `server/runtime.js` 的那些。这里没有一条是对选手的承诺，全部都可以在窗口期内更改而不使任何东西作废——它放在这里就是为了这个。

`drand.api` 是从哪里取信标。`drand.mirrors` 是服务器在肯开奖之前用来交叉核对答案的那一组：如果两个镜像对某一轮的签名给出不同答案，任务停下来，而不是挑一个（§9）。这两个字段都不可能影响结果，因为链由上面那两个冻结字段钉死。

`pantheon.event_title` 是页面对这场抽签的称呼。留空时在启动时从 Mimir 读取，并反复重读直到 Mimir 应答；一旦设了值就以它为准，这正是服务器连不上 Mimir 的部署所需要的。它在边界的这一侧，是因为它是个标签：它的任何取值都到不了种子、名册或轮次，一场标题写错的抽签是一场有错别字的抽签，不是一场被操纵的抽签。

同步用的 Pantheon 管理员凭证**不在**这个文件里，也永远不在仓库里。它们是环境变量（`deploy/README.zh.md` §6）。

为了防止这两类配置重新混到一起，加载器在 `protocol.json` 含有任何运营配置键时**直接拒绝**，并指出它发现的那一个。

### 4.3 运行过程写出的文件

**提交记录**（`events/submissions/<local_id>.json`，一到达就镜像进仓库）
```
{ "local_id": 3, "ciphertext": "<tlock 密文>", "received_at": "..." }
```
密文封存的是 `{user_input, client_nonce, client_timestamp}`（§3）。服务器存储并镜像它，却读不了它。
密文可以安全公开：在目标轮次到来之前，没有人能解密它们，组织者也不行。

**`events/snapshot.json`**（在截止时刻写出，此时信标尚不存在）
```
{ "cutoff_utc": "...", "taken_at": "...", "local_ids": [1,2,3,...],
  "submissions": [ { "local_id": 1, "ciphertext": "...", "received_at": "..." }, ... ] }
```
按时提交的那份名单。它在任何人能知道漏掉谁有用之前就被固定下来，而且是公开的，这正是验证者据以检查 `results.json` 是否对每一份提交都有交代、而不只是对它挑出来列的那些有交代的依据。它在 `results.json` **之前**被镜像，所以永远不会出现「结果可读但审计它所需的文件还没有」的情况。

**`results.json`**（开奖之后自动写出，恰好一次）
```
{
  "round_used": 123456,
  "drand_signature": "...",
  "participating_local_ids": [1,2,3,5,6,7,8,9,10,11,12],
  "excluded_local_ids": [ { "local_id": 4, "reason": "..." } ],
  "revealed": { "1": { "user_input": 7, "client_nonce": "...", "client_timestamp": "..." }, ... },
  "contributions": { "1": "<sha256 十六进制>", ... },
  "R": "<256 位十六进制>",
  "seed": "<sha256 十六进制>",
  "permutation": [ ... ],
  "seating": { ... 11 轮，真名 ... },
  "pantheon_prescript": "..."
}
```

**这个文件里的每一样东西都是 `generate.js` 产出的，没有别的来源。** `--verify` 依赖的正是这条性质：它重算整个文件并逐字节比对，不挑出任何字段，因此也不需要任何关于「实际检查了什么」的脚注。曾经住在这里的两样东西为此搬了出去，它们违反的那条规则值得写下来，因为对后续任何新增内容它都适用：

> 一个文件不能对它算不出来的值做出逐字节一致的主张。

- **`excluded_local_ids` 留下了，并且搬进了计算之内。** 一份打不开的提交不是一份贡献（§8），所以「谁被排除了」是「谁参与了」这个答案的一部分，属于那个主张之内。`generate.js` 现在把这份名单作为输入接收、校验它（每个 id 都在名册里、没有一个同时是参与者、每个都带理由），并以规范顺序输出。
- **`pantheon_sync` 走了。** 见下。

注意逐字节比对单靠自己仍然做不到的事：它是从这个文件所列出的载荷重算的，所以一个把某位选手同时从 `revealed` 和 `excluded_local_ids` 里漏掉的文件是自洽的。`events/snapshot.json` 是堵上这个口子的东西，`generate.js --verify` 在快照可用时执行这项检查，在不可用时直白说出来。

**`events/rounds/<target_round>/`**（某次尝试被判作废时写出，§8）
```
manifest.json     下面所有东西的摘要，加上计数和核验方法
protocol.json     那次尝试所依据的冻结参数
roster.json
void.json         公布出去的作废通知
snapshot.json     截止时取的那份提交名单
submissions/<local_id>.json
```
保留它们是为了让一次作废可以被审计，而不是被凭信接受，并登记在 `events/rounds/index.json` 里。见 §8。

**`events/sync.json`**（Pantheon 同步之后写出，而同步在开奖之后）
```
{ "round_used": 123456, "status": "ok", "at": "...", "event_id": 42, "attempts": 1 }
```
同步结果**刻意**不放进 `results.json`。它记录的是一次带墙钟时间戳、发生在 `results.json` 已经存在之后的网络调用，所以一个包含它的 `results.json` 就得描述一件晚于自己的事，永远不可能被重算。把它分开，正是 `results.json` 能够只写一次并被无保留地验证的原因。`GET /api/result` 为了 UI 把两者重新拼在一起；验证者用的是文件。

## 5. 端到端时序

1. **冻结。** 把 Pantheon 名册快照进 `roster.json`；选定 drand 链、目标轮次和截止时刻；写出 `protocol.json`——只放冻结参数，§4.1——和 `schedule_template.json`、`generate.js` 一起提交；打 git tag。向选手公布这个 tag。`runtime.json` 不属于这一步，也不打 tag。
2. **提交窗口。** 截止之前的任何时候，每位选手打开应用、用 Pantheon 账号登录、输入一个数字并提交。他的浏览器用 tlock 把这个数字封给 `protocol.json` 里的那条链和那个目标轮次，只发送密文。
3. **等待。** 应用展示一个实时视图：到目标轮次的倒计时、drand 链的健康状况、十二人里已提交了多少。这里不需要选手做任何事。
4. **开奖。** 到 `submission_cutoff_utc` 时服务器对已收到的提交做快照。≥ 8 份时它等待 drand 发布 `target_round` 的签名，解密、计算结果并发布。< 8 份时本轮被判作废。
5. **同步。** 生成的座位表作为活动的 prescripted seating 写进 Pantheon，并带着后续说明展示给选手。

## 6. 后端 API

所有端点都是 HTTPS 上的 JSON。

- `POST /api/session` —— body 为 `{person_id, auth_token}`，由浏览器从 Pantheon 取得（见 `PANTHEON-INTEGRATION.zh.md` §2）。服务器用 Frey `QuickAuthorize` 校验这一对，确认此人在冻结的名册里，然后签发一个 httpOnly 的会话 cookie。**服务器从不接触 Pantheon 密码。**
- `GET /api/me` —— 已登录选手的 `{local_id, title, submitted: bool}`。
- `POST /api/submit` —— body 为 `{ciphertext}`。如果该会话对应的席位已经提交过，或者已过截止时刻，则被拒绝。存储并镜像进仓库。
- `GET /api/status` —— 公开，不需要会话。等待视图所需的一切：
  ```
  { phase: "open" | "awaiting_round" | "revealing" | "done" | "void",
    submitted_count, quorum, total_slots,
    submitted_local_ids: [...],            // 谁，不是什么
    cutoff_utc, target_round, user_input_max,
    drand: { chain_hash, chain_public_key,  // 冻结的：浏览器用来钉死链
             api,                           // 运营的（§4.2）：从哪里访问它
             latest_round, expected_round_at_cutoff, healthy: bool, last_seen_utc },
    frey_base_url, status_poll_interval_ms, // 运营的（§4.2）
    mirror_repo,                            // §5 把证据发布到哪里，好让结果页
                                            // 指名它；未开启镜像时为 null
    server_time_utc }                       // 让倒计时永不漂移

  应用展示给选手的每一个冻结数字都来自这里，所以页面永远不可能说出
  一条不同于抽签所打 tag 的规则。
  ```
- `GET /api/result` —— 开奖之后：`results.json` 的内容，外加座位表浏览器渲染所需的逐人派生统计（见 `UI-SPEC.zh.md` §6）。
- `GET /api/events` —— Server-Sent Events 流，推送 `status` 变化，让等待视图不靠轮询也能更新。流断掉时的退路是轮询 `/api/status`；节奏默认 15 秒，并在 status 载荷里以 `status_poll_interval_ms` 提供（`runtime.json` → `ui`，§4.2），而不是编译进 bundle。
- **定时任务** —— 不是 HTTP 端点。在截止时刻执行 §5 的开奖，然后执行 Pantheon 同步。

## 7. `generate.js` 规范

```
输入：
  decrypted = [(local_id, user_input, client_nonce, client_timestamp), ...]   // n 条，8 <= n <= 12
  drand_signature                                                             // 对应 target_round

1. 按 local_id 升序排序                          // 异或与顺序无关；这么做只是
                                                 // 让审计日志可复现
2. contribution_i = SHA256(DOMAIN || "contrib" || local_id || user_input
                                  || client_nonce || client_timestamp)        // 256 位，不截断
3. R = contribution_1 XOR ... XOR contribution_n                              // 256 位
4. seed = SHA256(DOMAIN || "seed" || R || drand_signature || sorted(local_ids))
5. 用 CSPRNG（计数器模式的 SHA256）把 seed 扩展出足够的字节，做一次无偏的
   Fisher-Yates 洗牌，得到十二个名册席位的排列 pi
6. 按 pi 把名册席位映射到 schedule_template.json 的抽象点 0..11
7. 代入真实姓名，得到最终的 11 轮座位表
8. 输出 results.json（§4）和 Pantheon prescript 字符串（PANTHEON-INTEGRATION.zh.md §3）
```

`DOMAIN` 是 `protocol.json` 里的 `seed_domain_separation`。把字节编码钉死和算法本身同等重要：`local_id` 和 `user_input` 各为单个无符号字节，`client_timestamp` 用它的 ASCII ISO-8601 形式，所有字段之间用一个不可能出现在它们内部的字节分隔。把这套编码写进实现并用固定向量测试它，否则同一场抽签的两次独立重算就会对不上。

第 4 步里加入 `sorted(local_ids)`，消除了 `n < 12` 时关于「谁参与了」的任何歧义。

第 5 步用拒绝采样，不要用取模，这样洗牌才是严格均匀的。

## 8. 门槛与失败处理

- `quorum = 8` 和其他一切一起冻结，提交开放之后不可调整——在看到谁没交之后做的调整，本身就是一个可操纵的步骤。这是 §4.1 判据最清楚的一个例子：这个值不过是配置文件里的一个数字，而它之所以被冻结，恰恰是因为知道谁没交会让「选这个值」变成一步棋。
- 加载器拒绝小于等于人数一半的门槛。§8 想要的是三分之二规则，而少数派门槛不是任何人会事先同意的东西——而事先，是同意这件事唯一有意义的时刻。
- 快照恰好在 `submission_cutoff_utc` 这一刻取。晚于此的任何东西都不计入，哪怕 drand 轮次还没落地。这消除了关于迟到的一切争论。
- 没达到门槛只有一种事先约定的补救：本轮作废，公布新的 `target_round`，让**全部十二人**重新提交。已有的密文绑定在已经过去的那一轮上，不能再用。
- **作废的尝试只归档，绝不丢弃。** 「不到八人提交」是一个主张，而且恰恰是一个想在看清来了谁之后再来一次的组织者会做出的主张。让它成为事实的是证据，所以在一轮被判作废的那一刻，任务会写出 `events/rounds/<target_round>/`，里面装着按收到原样保存的每一份密文、截止时取的提交名单、作废通知、**那次尝试所依据的冻结 `protocol.json` 和 `roster.json`**，以及一份 SHA-256 摘要的 `manifest.json`。全部都会被镜像，因此像密文本身一样由第三方打上时间戳。

  归档的 `protocol.json` 是承重的那部分。下一次尝试会用新的 `target_round` 覆盖那个文件，没有这份副本，归档里的密文就会指向一条链和一个轮次，而仓库里再无任何记录。

  作废那一轮的信标无论谁做什么三秒后都会落地，所以归档任何人都能验证，什么时候有空什么时候验：
  ```sh
  node tools/decrypt-submissions.js \
    --dir events/rounds/<target_round>/submissions \
    --protocol events/rounds/<target_round>/protocol.json
  ```
  它会打开归档里的每一份密文并数一遍。`events/rounds/index.json` 列出各次尝试和每份 manifest 的摘要。
- **先重新冻结，再重置。** 开启下一次尝试是运营者的一个刻意动作（`tools/new-round.js`），并且它会拒绝，除非：这一轮确实被判了作废、它的归档逐字节验证通过、`protocol.json` 里已经写着一个更晚的 `target_round` 且截止时刻在未来、并且不存在 `results.json`。于是绝不会出现「组织者手里有一个开着的轮次却没有公布过目标」的时刻。因为已提交的人选而重启一个仅仅是开着的轮次，正是这条规则要消除的那个可操纵步骤。
- **到点时 drand 迟到或连不上**是延迟，不是失败。密文和轮次都没变，所以结果早已确定；等信标能连上时重跑任务即可。
- **某个 drand 镜像挂掉**连延迟都算不上。把 `runtime.json` 指向另一个并重启；不碰任何冻结的东西，因为链由 `chain_hash` 和 `chain_public_key` 钉死，而不是由某个地址（§4.2）。

## 9. 信任边界

关于服务器没有任何东西需要被信任：它持有的每一份密文都可以安全公开，而且它没有任何能提前打开其中一份的密钥。关于任何选手也没有任何东西需要被信任：在任何人提交的那一刻，其余每一份提交都还封着，所以谁也无法自适应地选择。活的依赖有两个：drand 在目标轮次的可用性，以及 Pantheon 对「谁报名了这场活动」的回答。

一个始终没有提交的选手，是对一个当时谁也看不见的结果弃权了——那是缺席，不是手段。没有人能扣住一次**揭示**，因为打开不是任何参与者执行的动作。

### 这套设计本身挡不住的那个攻击

上面那段关于**扣住**是成立的。关于**增加**则不成立，而这个差别正是本设计唯一真实的弱点。

假设十二人中有一位与组织者串通，约定不提交。截止时刻过去，手上有十一份密文。信标落地，组织者解开全部十一份，于是知道了其余每一份贡献以及那个 drand 签名。因为 `R` 是异或，第十二份贡献是一个自由变量：`R` 的任何取值都可以通过选择它来达到。而一份贡献是 `SHA256(DOMAIN ‖ "contrib" ‖ local_id ‖ user_input ‖ client_nonce ‖ client_timestamp)`，其中 `client_nonce` 是提交者自己挑的十六个字节。所以他们可以穷举：试各种 nonce，算出每一个产生的种子，跑一遍洗牌，留下自己最满意的那张座位表。每次试验不过两次哈希加一次洗牌。一台普通机器跑几分钟就能买到几百万个候选座位表。

然后组织者发布一份有十二条的 `snapshot.json`，说最后一条是在截止前不久到的。

这不是时间锁的缺陷。tlock 保证的是没人能提前打开一份密文；它对**一份密文是什么时候写出来的**只字未言。加密给第 *N* 轮只需要链的公钥，而那从一开始就是公开的，所以密文自身不携带任何关于自己年龄的证据。因此一位串通的选手加上组织者，就足以直接选定结果——不是轻推，是选定。

### 真正把一份提交绑定到时间的是什么

不是密码学。绑定必须来自「到达记录是公开的、并且在密钥存在之前就已固定」，而这需要三样东西，没有一样是服务器的一面之词。

**一个间隔。** `submission_cutoff_utc` 比 `target_round_utc` 早 `reveal_gap_seconds`，默认十分钟（§4.1）。这两者过去是同一时刻，那让人无处立足：任何关于提交名单的记录都是在密钥变得可用的那一刻做出的，因此它没法说明谁在前。这个间隔就是名单已被固定、而结果仍然不可知的那个窗口。`config.js` 拒绝三个字段互相矛盾的 `protocol.json`，也拒绝短于一分钟的间隔。

**一个组织者挪不动的时间戳。** 截止时取的那份名单会在这个间隔内用 OpenTimestamps 锚定。锚定证明这个集合在某个比特币区块之前就已存在，而这恰恰是一份伪造的第十二份提交无法满足的主张：选出它需要密钥，而密钥此时还不存在。

选手端界面把这个文件叫**密文提交结果**而不是**提交名单**——同一个文件 `events/snapshot.json`，同一份摘要。「名单」是本文档对它的叫法，选手为了和另外十一个人比对一串字符串，并不需要学会这个词。

**一个公布出去的单一值。** 光有锚定还不够，因为锚定很便宜，没有什么能阻止组织者在这个间隔里锚定许多份候选名单，事后再揭示合适的那一份。排除这一点的是：在间隔仍然开着的时候，把名单的摘要公布给选手。十二个能互相比对同一串短字符串的人，比任何单一公证人都更难被骗，因为撒谎需要给不同的人看不同的值，而他们每一个都能核对。

同样的论证适用于冻结。一个只存在于组织者机器上的 tag 不构成承诺；它必须在提交开放之前被推送到一个公共主机上，它的 commit id 必须随通知一起传出去，而且它也要被锚定。

### 什么仍然成立，什么是假设

有了上面这些：关于服务器，就**保密性**而言没有任何东西需要被信任——它没有任何能提前打开一份提交的密钥，它持有的每一份密文都可以安全公开。关于任何选手也没有任何东西需要被信任，因为在任何人提交的那一刻，其余每一份提交都还封着。

被假设的东西更弱，应当直说：至少有一个组织者之外的人在那个间隔里看过那份名单，或者保存了那份锚定。如果从来没人核对，证据仍然在那里，多年后仍然可查——但一个没人去找的攻击就是一个没人会发现的攻击。协议让作弊变得可被发现。它没法让任何人去看。

还有一条边界根本不关抽签的事，而且很容易被说得太轻。选手用 Pantheon 账号登录，而这个应用不是那份凭证的住处：浏览器把邮箱和密码直接发给 Frey，后端只收到 `{person_id, auth_token}`（`PANTHEON-INTEGRATION.zh.md` §2）。这里没有任何代码路径读取密码字段。

但 `auth_token` 不是会话 token。Frey 把它导出为 `sha384(password + account_salt)`，返回它，此后一直接受它——它不过期也不轮换，所以在选手改密码之前它等价于密码。因此后端把它当作一个仅在传输中的秘密，仅此而已：对着 Frey 校验一次，从不写进数据库，从不写进日志，从不回显。它换发出去的 cookie 是 32 个不相干的随机字节，以哈希形式存储，所以 `var/` 里没有任何东西能被还原成一份 Pantheon 凭证。

于是传输层就是全部的保护，既保护去往 Frey 路上的密码，也保护来到这里路上的 token。§10 里的 TLS 不是叠在一个已经能工作的部署之上的加固步骤；没有它，上面两样都得不到保护，而且会话 cookie 根本不会被浏览器存下来。

## 10. 部署

应用和 Pantheon 跑在同一台主机上，所以后端到 Pantheon 的调用走 localhost。一个小的后端进程（Node 或 Python）、用 SQLite 存状态、一个持有 GitHub PAT 的镜像脚本，前面一个反向代理终结 TLS——主机上已经有 nginx 的用 nginx（Pantheon 共用这台机器时就是这种情况），否则用 Caddy。对 `main` 的写权限收窄到后端使用的那个 PAT。

有一个地址不遵守这条规则。浏览器自己要访问 Frey，所以给它的 URL 必须能从选手的设备上解析，而不是从主机上；`runtime.json` 用 `pantheon.frey_base_url` 和 `pantheon.frey_public_url` 把两者分开。
