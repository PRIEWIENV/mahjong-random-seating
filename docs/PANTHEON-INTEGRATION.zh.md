# Pantheon 集成

> [English](PANTHEON-INTEGRATION.md) · 简体中文

抽签应用和一套自托管的 [Pantheon](https://github.com/MahjongPantheon/pantheon) 实例并排跑在同一台服务器上。Pantheon 提供身份和活动名册，并接收完成的座位表。

下面的内容全部是从 `master` 分支 `Common/proto/` 里的 Pantheon 协议定义读出来的，然后**对着一个运行中的实例核对过**（Pantheon `cdda3fc`，2026 年 9 月）。这次核对很值得：proto 文件和运行中的服务在四处不一致，每一处都是静默的，§6 记录了把它们找出来花了什么代价。请对着你实际要用的那个实例重跑一遍——§5 里的值是关于某一个部署的事实，不是关于 Pantheon 一般情况的事实。

## 1. 服务与传输

Pantheon 是一组说 [Twirp](https://twitchtv.github.io/twirp/)（HTTP 上的 protobuf）的服务。这里要紧的是两个：

- **Frey** —— 账号与认证。
- **Mimir** —— 活动、报名选手、对局、座位。

由于两者和本应用跑在同一台主机上，后端到 Pantheon 的调用应当走 localhost，而不是公网主机名。

## 2. 登录，以及把它限制在一场活动内

需求是：只有报名了某一场特定活动的选手才能登录。

**不要让本应用接触 Pantheon 密码。** 浏览器直接向 Frey 认证，只把得到的那一对交给我们的后端：

1. 浏览器 → Frey `Authorize({email, password})` → `{person_id, auth_token}`。
2. 浏览器 → 我们的 `POST /api/session`，带 `{person_id, auth_token}`。
3. 后端 → Frey `QuickAuthorize({person_id, auth_token})`，验证这一对是真的。
4. 后端 → Mimir `GetAllRegisteredPlayers({event_ids: [EVENT_ID]})` → `RegisteredPlayer[]`，每条带有 `id`（person id）、`title` 和 `local_id`。
5. 只有当 `person_id` 同时出现在那份名单里**并且**出现在冻结的 `roster.json` 里，登录才成功。否则：以「这个账号没有报名本次活动」拒绝。
6. 成功后后端签发自己的 httpOnly 会话 cookie，其中携带 `local_id`。

同时对着实时 Pantheon 名册和冻结快照检查是刻意的。实时检查是授权；冻结检查确保冻结之后的一次名册编辑不能悄悄扩大或改变这十二人的范围。

### 这份凭证到底是什么

「本应用从不接触 Pantheon 密码」是真的，也值得保持为真，但这不是完整的陈述，因为这个应用**确实**接触的那样东西比这句话听起来更强。

Frey 的 `Authorize` 接收明文密码并自己做哈希（`Frey/app/models/auth.ts`）：

```ts
const authToken = makeClientHash(payload.password, personData[0].auth_salt);
await verifyHash(authToken, personData[0].auth_hash);
return { personId: personData[0].id, authToken };
```

`makeClientHash` 就是 `sha384(password + auth_salt)`，`verifyHash` 用 bcrypt 把它和存储的哈希比对。由此有两件事。

**密码在请求体里穿过网络。** 保护它的只有 TLS。Frey 没有提供先哈希的途径——那需要账号的盐，而一个对任意邮箱都发放盐的端点就是一台账号枚举预言机。所以这是 Pantheon 提供的唯一路径，它的安全性恰好等于传输的安全性。这也是部署绝不能跑在明文 HTTP 上的最强单一理由：明文穿过网络的那个密码不是这场活动可以拿去冒险的东西，它是选手的 Pantheon 账号。

**返回的 `auth_token` 等价于密码。** 它是密码和每账号盐的确定性函数：不过期、不轮换，并且只要密码不变，`QuickAuthorize` 和 Frey 自己的访问检查（`models/access.ts`）就一直接受它。任何持有它的人都能以那个人的身份行事。所以后端没有收到密码，但它收到了一样能打开同一扇门的东西。

后端拿它做什么，以及任何重新实现都必须继续做的事：

- **用一次，然后扔掉。** 它被送去 `QuickAuthorize`，然后离开作用域。它从不被写进数据库。`Store.createSession` 只接收 `local_id` 和 `person_id`，别的什么都不接收。
- **绝不记录它。** 成功那一行日志记录的是 `local_id` 和选手的名字。不记 token，不记邮箱。
- **签发一个不相干的 cookie。** 会话 cookie 是 32 个全新的随机字节，以哈希形式存储，有自己的有效期。攻破本应用的会话存储得不到任何 Pantheon 凭证。
- **绝不回传。** 没有任何端点回显它。唯一返回 token 对的端点是 `/api/dev-authorize`，它只在桩模式下存在，生产环境下返回 404。

与之对应的运营侧要求在 `deploy/README.zh.md` 里：TLS，以及一个不记录请求体的反向代理。一条带 `$request_body` 的 `log_format` 就会把每位选手的 Pantheon 密码写进磁盘上的一个文件。

第 1 步正是 Frey 在 `runtime.json` 里有**两个**地址的原因。`frey_base_url` 是后端用的，从服务器上访问，此时 localhost 是正确且正常的；`frey_public_url` 是浏览器用的，而在手机上 localhost 就是那台手机。它们曾经是同一个字段，直到某次部署填了 localhost 那种写法，于是每位选手都被告知密码错误——浏览器收到的是连接被拒绝，而页面把它叫成了凭证失败。现在服务器在启动时会对「面向浏览器的 URL 是回环或私有地址」发出警告，`/admin` 里有对应的一行，登录页也区分开了「Frey 说不行」和「Frey 根本没应答」。

选手能据以行动的只有这两种结果。线级别的那些是可区分的，也值得知道：

| Frey 的回答 | 含义 |
|---|---|
| `400 invalid_argument` `Password check failed` | 密码不对 |
| `404 not_found` `Person not found in database` | 邮箱不对 |
| `404 bad_route` | 服务名或路径模板不对 |
| 一个不是 JSON 的 404 | 请求根本没进 Twirp；应答的是 nginx |
| 什么都没有 | CSP、混合内容、DNS、防火墙 |

相关的 Frey 方法：`Authorize`、`QuickAuthorize`、`Me`、`GetPersonalInfo`。
相关的 Mimir 方法：`GetAllRegisteredPlayers`。

`Common/proto/atoms.proto` 里定义的 `RegisteredPlayer`：
```
message RegisteredPlayer {
  int32 id = 1;
  string title = 2;
  optional int32 local_id = 3;
  optional string team_name = 4;
  string tenhou_id = 5;
  bool ignore_seating = 6;
  optional ReplacementPlayer replaced_by = 7;
  bool has_avatar = 8;
  string last_update = 9;
}
```

冻结之前，确保这十二人每一个都分配了 `local_id`（Mimir `UpdatePlayersLocalIds`）；座位表是用 local id 写回去的，所以缺一个就会卡住同步。

## 3. 把座位表写回去：prescript

Pantheon 支持 *prescripted*（预设）活动，每一节的座位都事先写好。这正是我们的情况。

**风位只有在调用方明说时才保得住。** 写 prescript 不是全部：它指定的风位是在一节**开始**时由 `MakePrescriptedSeating` 应用的，而那个请求携带它自己的 `wind_shuffle_mode`。这个字段在 proto 里是 optional，而 Mimir **不会**回落到活动自身存储的设置——`helpers/Seating.php` 把每一个无法识别的值，包括 UNSPECIFIED，都送去 `_randomWindShuffle`：

```php
default:
    // fallback to random
    // this includes empty and UNSPECIFIED values
    return self::_randomWindShuffle($seating);
```

Forseti 会读 `eventConfig.windShuffleMode` 并把它传过去，所以只要活动本身是以 `WIND_SHUFFLE_MODE_PRESCRIPTED` 创建的，组织者在界面上按那个按钮就是安全的——这也是硬性规则 5 的要求，以及 `tools/pantheon-fixture.js` 所设置的。任何**其他**调用方，脚本也好 curl 也好，都必须显式发送这个模式。省略它会保住桌子但打乱座位，报告成功，而且看起来完全像是本项目抽签的一个 bug。已对着运行中的实例验证：同一个请求带上模式，十二人全部按抽签结果就座；不带，十二人里只有三人对。

**格式。** Mimir 把 prescript 存成一个字符串，并这样解包（`EventPrescript::unpackScript`）：

- 各节之间用**空行**分隔（`\n\n`）
- 一节内部各桌之间用**换行**分隔
- 一桌上的四位选手之间用**连字符**分隔
- 那些数字是 **local id**，它们的顺序就是座次

所以一场十一轮、三桌的活动读起来是：

```
1-2-3-4
10-9-11-12
6-7-8-5

6-11-5-12
1-3-9-2
4-8-7-10

... 还有九块
```

每一行是一张桌，按东-南-西-北书写。

**写入。** Mimir `UpdatePrescriptedEventConfig({event_id, next_session_index, prescript})`。先用 `GetPrescriptedEventConfig({event_id})` 读一遍当前值，它返回 `{event_id, next_session_index, prescript}`。发布一份全新的座位表时把 `next_session_index` 设为 `1`。

**应用。** Pantheon 用 `MakePrescriptedSeating({event_id, wind_shuffle_mode})` 从 prescript 生成每一节的座位，`GetNextPrescriptedSeating` 可以预览下一节。

> **关键。** 必须传 `wind_shuffle_mode = WIND_SHUFFLE_MODE_PRESCRIPTED`（值为 `3`）。其他模式会在桌上重新随机风位，那会毁掉条件 3 和条件 6——风位平衡和上下家平衡恰恰是模板把优化预算花在上面的东西。写对了 prescript，然后让 Pantheon 悄悄洗掉风位，等于把大半工作扔了。

活动本身必须被标记为 prescripted（活动上的 `is_prescripted`；创建时设置，或者通过 `UpdateEvent`），这样手动和自动排座对它都会被禁用。

修改活动配置的调用需要管理员账号，所以后端在同步这一步需要它自己的 Pantheon 管理员凭证——放在服务器的环境变量里，绝不进仓库，也绝不和上面选手登录那条路径混在一起。Pantheon 配置里非机密的那一半（基础 URL、Twirp 路径模板、服务名）住在 `runtime.json` 里，刻意放在冻结之外：Pantheon 在主机上的位置影响不了抽签。而同步被允许写什么是有影响的，所以 `wind_shuffle_mode` 留在冻结的 `protocol.json` 里（`PROTOCOL.zh.md` §4.1）。

## 4. 同步失败的处理

同步发生在抽签已经终局并公布之后，所以那里的失败是运营上的麻烦，不是公平性问题——无论 Pantheon 怎么说，`results.json` 里的座位表都是权威的，并且可以从公开数据复现。

把同步结果记进 `events/sync.json`（**不要**记进 `results.json`，那个文件只写一次，必须保持逐字节可复现——`PROTOCOL.zh.md` §4.3），带退避重试几次，如果仍然失败，就在管理视图（`/admin`，由 `ADMIN_TOKEN` 把门）里暴露出来，退回到手工把 prescript 粘进 Pantheon 自己的管理界面。**不要**因为同步失败而重新生成或重新开奖。

## 5. 方法参考

这里列出的方法，都对着 `Common/proto/*.proto` 核对过**并且对着一个运行中的实例实际调用过**：

| 用途 | 服务 | 方法 |
|---|---|---|
| 密码登录（浏览器 → Pantheon） | Frey | `Authorize` |
| 校验 token 对（后端） | Frey | `QuickAuthorize` |
| 活动名册，带 local id | Mimir | `GetAllRegisteredPlayers` |
| 冻结之前分配 local id | Mimir | `UpdatePlayersLocalIds` |
| 读取当前 prescript | Mimir | `GetPrescriptedEventConfig` |
| 写入座位表 | Mimir | `UpdatePrescriptedEventConfig` |
| 应用某一节的座位 | Mimir | `MakePrescriptedSeating` |
| 预览下一节的座位 | Mimir | `GetNextPrescriptedSeating` |

### 5.1 线上实际长什么样

通过调用一个运行中的实例确认。以下六项在第一版实现里全都是错的，而且没有一项是大声失败的。

| | 从 proto 猜出来的 | 实例实际的行为 |
|---|---|---|
| URL 路径 | `/twirp/{service}/{method}` | `/v2/{service}/{method}` |
| 服务段 | `frey.Frey`、`mimir.Mimir` | `common.Frey`、`common.Mimir` |
| 开发端口 | Frey 4001、Mimir 4002 | **Mimir 4001、Frey 4004** |
| 请求字段 | snake_case | snake_case —— 两个服务都接受 |
| **响应字段** | snake_case | **lowerCamelCase**：`personId`、`authToken`、`authSuccess`、`tenhouId`、`localId` |
| 凭证错误 | `{auth_success: false}` | HTTP 400 `invalid_argument` "Password check failed" |

其中两项值得展开讲，因为它们是会咬人而不是会直接撞墙的那种。

**一个取默认值的字段是缺席，不是 null。** 这是 protobuf 的 JSON 映射，它意味着一个没分配的 `local_id` 在响应里根本不出现，`ignore_seating: false` 也不出现，`auth_success: false` 也不出现。写 `p.local_id ?? null` 的代码是碰巧对了；把缺席字段当成「服务器没说」的代码是错的。一个为 `true` 的 bool 总是出现，这正是 `authSuccess === true` 能作为登录成功的完整判据的原因。

**凭证不对是一个错误，不是一个 false。** Frey 的 `quickAuthorize` 要么返回 `{authSuccess: true}`，要么抛出：token 不对是 400 `invalid_argument`，人不存在是 404 `not_found`。一个让这些异常直接冒泡的客户端，会把打错的密码报成「Pantheon 连不上」——一个 503，而 UI-SPEC §3 要求的是一个可区分的 401。`server/pantheon.js` 把 400、401、403 和 404 当作拒绝，对 5xx 和 429 继续抛出，这样故障仍然读起来是故障。

**管理员调用需要活动作用域。** Mimir 读 `X-Auth-Token`、`X-Current-Person-Id` 和 `X-Current-Event-Id`（`Mimir/src/Meta.php`），而活动管理员和裁判权限是由第三个来限定作用域的。没有它，prescript 写入会被拒绝——在开奖之后，什么都改不了的时候。

## 6. 搭一个本地 Pantheon 来测

整个集成是在没有本地实例的情况下写出来的，这就是 §5.1 存在的原因。搭一个大约要半小时。

Pantheon 自己的 README 说不支持 Windows；用 WSL 2 或 Linux。在里面：

```sh
git clone https://github.com/MahjongPantheon/pantheon.git && cd pantheon
docker compose -f docker-compose-amd64.yml up -d mimir.pantheon.internal frey.pantheon.internal redis.pantheon.internal
(cd Mimir && make container_deps && make container_migrate)
(cd Frey  && make container_deps && make container_migrate)
make bootstrap_admin        # admin@localhost.localdomain / 123456
(cd Mimir && make container_seed)
(cd Frey  && make container_dev &)   # Frey 的开发服务器；nginx 在 :4004 上代理到它
node tools/pantheon-fixture.js       # 我们的活动：prescripted，12 位选手，local id 1..12
```

有五件事加起来花掉了一小时，而且从文档里完全看不出来：

- **Host 头决定一切。** 每个容器的 nginx 都按 `server_name mimir.pantheon.local` 匹配，并有一个应答 404 的兜底。所以对 `http://127.0.0.1:4001` 的请求即便服务是健康的也会 404。要用主机名，并在 `/etc/hosts` 里加上指向 127.0.0.1 的条目。这就是 `runtime.json` 里 Pantheon 基础 URL 用主机名而不是地址的原因。
- **WSL 每次启动都重写 `/etc/hosts`。** 先在 `/etc/wsl.conf` 的 `[network]` 段下写上 `generateHosts = false`，否则那些条目会消失，症状是一分钟前还好好的服务突然 404。
- **需要这些条目的是两台机器，不是一台。** WSL 的 `/etc/hosts` 只管在 WSL 里跑的东西，而有两样东西经常不在里面。一是 relay，它在你启动它的那一侧；在 Windows 上跑、容器在 WSL 里，启动时就会得到 `GetEventsById: fetch failed`，页面标题里也不会有活动名称。二是浏览器，它永远在外面，而且它是**自己**去连 Frey 的，不经过 relay（§2：服务端绝不看到 Pantheon 密码），所以无论 relay 在哪一侧，`frey.pantheon.local` 都必须在 Windows 能解析。把两个名字都加进 `C:\Windows\System32\drivers\etc\hosts` 指向 `127.0.0.1`，或者用 `PANTHEON_MODE=stub` 开发，后者两样都不需要。把 URL 改成 `127.0.0.1` 是不行的：那样 Host 头就是 `127.0.0.1`，nginx 回 404，也就是上面第一条。
- **Frey 每一个请求都会调用 Hugin。** 它的指标中间件 `await` 一个到 `hugin/addMetric` 的 POST 并把失败包起来，所以 Hugin 没跑的时候**每一个** Frey 调用都返回 500 `fetch failed`。把 `hugin.pantheon.internal` 也启起来。
- **Redis 会缓存否定查询。** 在某人存在之前对他探测 `QuickAuthorize`，会把「不认识」缓存下来，之后正确的调用仍然失败。种子数据灌完之后跑一下 `redis-cli FLUSHALL`。
- **只有 tournament 类型能被 prescripted。** `CreateEvent` 对 club 和 online 类型的活动硬性设置 `is_prescripted = 0`。它报告成功，它也如实存下 `wind_shuffle_mode`，唯一的症状是 `GetAllRegisteredPlayers` 返回不出任何 local id——因为 Mimir 只为 prescripted 活动填它们。RUNBOOK 第 8 步的活动必须是 `EVENT_TYPE_TOURNAMENT`。

`tools/pantheon-fixture.js --accounts` 还会通过 Frey 的 `CreateAccount` 额外创建那十二位选手，带上它打印出来的邮箱和密码，这样真实的登录路径可以被走一遍而不是被假定。没有它，选手是从实例的种子数据里借来的，没人知道他们的密码——对抽签来说够用，因为抽签只处理 person id，但对选手要做的第一个请求来说不够。重跑是安全的：Frey 对见过的邮箱回答 `409 already_exists`，fixture 会通过以那个账号登录来找回 person id。

`tools/pantheon-fixture.js` 通过 API 完成 RUNBOOK 第 8 步的其余部分：从实例复制一套规则集（`CreateEvent` 在没有完整规则集时会拒绝）、创建比赛、登记十二位选手并分配他们的 local id，然后按 `tools/freeze.js` 将来的方式把它们读回来。
