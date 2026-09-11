# 部署（PROTOCOL.zh.md §10）

> [English](README.md) · 简体中文

一个 Node 进程跑在反向代理后面，状态存在 SQLite 里。它既服务页面，也用自己的定时器负责开奖，所以没有别的东西要装，也不需要 root。应用和 Pantheon 共用一台主机，所以后端到 Pantheon 的调用走 localhost。

这里没有任何一份秘密能提前打开一份提交。机器上仅有的两份凭证是用于镜像的 GitHub PAT 和用于座位表同步的 Pantheon 管理员账号——这两者最坏也只能往某处写东西。

## 1. 安装

```sh
adduser --system --group --home /opt/mahjong mahjong
git clone <repo> /opt/mahjong/app && cd /opt/mahjong/app
git checkout frozen-v1                     # RUNBOOK 第 11 步打的那个 tag
npm ci --omit=dev
node tools/build-client.js --verify-hash   # 已提交的 bundle 与其已提交的哈希一致
node tools/verify-template.js              # 重新推导模板不变量
chown -R mahjong:mahjong /opt/mahjong
```

`<repo>` 是**你的**仓库，不是这份代码被开发出来的那个。冻结是对你正在运行的一场活动做出的承诺：`data/protocol.json` 和 `data/roster.json` 装着你的目标轮次和你的十二位选手，它们在上游被 gitignore 正是为此，而 `tools/freeze.js` 会把它们强制加进你打 tag 并推送的那棵树里。fork 它，或者把它克隆到一个你能推送的地方，然后在那里冻结。选手拿到的是那个 tag 和那个 commit id；一个除你之外谁也拉不到的 tag 不构成承诺（`PROTOCOL.zh.md` §9）。

`npm ci --omit=dev` 是刻意的：服务器需要 `tlock-js`，其他什么都不需要。

如果在一份**全新克隆**上 `--verify-hash` 失败了，先怀疑检出，再怀疑 bundle。`core.autocrlf` 打开时 git 会在检出时改写行尾，而那是 Windows 的默认设置：blob 是 347717 字节、没有 CR，工作副本出来是 347738 字节、带 21 个 CR，摘要就不是同一个摘要了。本仓库的 `.gitattributes` 对每一份按字节钉死的产物关掉了这个行为，所以一份仍然出现这个问题的检出，要么是在那个文件存在之前做的，要么是本地设置盖过了它。用 `git check-attr text eol -- public/app.js` 检查。

注意两种 bundle 检查各自跑在哪里。`--verify-hash` 把已提交的 `app.js` + `app.css` 和它们已提交的摘要比对，不需要任何依赖，这正是它在这里运行的原因——`--omit=dev` 意味着这台机器上没装 esbuild。强的那种检查是 `node tools/build-client.js --check`，它从源码重建并比对结果；那一项要在冻结提交**之前**在开发机或 CI 上跑。

## 2. 环境变量

`/opt/mahjong/app/.env` —— 权限 600，属主 `mahjong`，已被 `.gitignore` 覆盖：

```sh
PORT=8080
HOST=127.0.0.1
NODE_ENV=production

# 运营配置的可选覆盖（PROTOCOL.zh.md §4.2）。同样的值也可以写进
# data/runtime.json；两者都不冻结，改哪一个都不需要重新打 tag。
# DRAND_API=https://api2.drand.sh
# PANTHEON_FREY_URL=http://frey.pantheon.local:4004
# PANTHEON_MIMIR_URL=http://mimir.pantheon.local:4001
PANTHEON_MODE=twirp                  # 默认值；"stub" 只用于本地运行

# 镜像：密文一到达就变成公开的，并由第三方打上时间戳。
MIRROR_REPO=youruser/mahjong-random-seating
MIRROR_BRANCH=main
MIRROR_TOKEN=github_pat_...          # contents:write，收窄到这一个仓库

# Pantheon 管理员，仅用于座位表同步（PANTHEON-INTEGRATION.zh.md §3）。
# 绝不用在选手登录路径上。
PANTHEON_ADMIN_PERSON_ID=...
PANTHEON_ADMIN_TOKEN=...
```

```sh
# 组织者面板。没有这个，/admin 路由根本不存在。
ADMIN_TOKEN=...                      # openssl rand -hex 16
```

`PORT` 和 `HOST` 也可以在命令行给出，且命令行优先：`node server/server.js --port 9000 --host 127.0.0.1`。8080 已被占用时很有用，而在同时跑着 Pantheon 的机器上它经常被占。无论用哪种，§4 里的反向代理都必须指向同一个端口号；端口已被占用会被如实报出，并告诉你改用哪个参数。

`NODE_ENV=production` 的意义不止于日志：它给会话 cookie 标上 `Secure`，并让 `/api/dev-authorize` 返回 404。那个端点是 Frey 的开发替身；它绝不能存在于这里。

`ADMIN_TOKEN` 为 `/admin` 把门，那里显示提交进度、还差谁、起飞前检查和同步结果。不设置时这条路由像任何其他路径一样 404，所以一个从未配置过它的组织者也就没有不小心公开一份名册和一条提交时间线。这个页面按设计是只读的：开奖、重置和同步都是在这台机器上执行的命令，因为 §9 要求任何可能触发或改变开奖时机的东西不经过 HTTP。像对待 PAT 一样对待这个 token——它会透露谁提交了、什么时候提交的，这些信息本来就是公开的，但没有理由到处发。

`data/runtime.json` 是那些覆盖项的文件版本，同样是可选的。它被刻意 gitignore：里面没有任何东西能改变结果，而把它排除在树之外，能让「它从来不在冻结范围内」这件事一目了然。如果某个 drand 镜像在提交窗口期间挂了，你要编辑的就是这个文件——不是某个已打 tag 的文件。

把 GitHub PAT 收窄到这一个仓库，且只给 contents:write。按 §10，对 `main` 的写权限应当限制给那个 token，这样密文历史在实践上也和在原则上一样是只追加的。

## 3. 如何运行

一个进程：

```sh
node server/server.js
```

这就是整个部署。服务器既服务页面**也**负责开奖，每隔 `server.finalise_interval_seconds`（§4.2，默认 60 秒）派生一次 `server/finalise.js --no-wait`。开奖仍然是一个独立的程序——§9 要求它不走 HTTP，这样任何选手能戳到的东西都不能触发或改变它的时机——但为了让它发生，仓库之外不需要配置任何东西。

早期版本要求两个 systemd 单元。那在两个层面上都是错的：注册单元需要 root，而组织者未必拥有那台机器；而且它在 Windows 上根本不存在，而开发和排练正是在 Windows 上做的。现实的结果是一个页面服务得很好、却永远不开奖的部署。

**让这一个进程活着**用你机器上有的任何办法，没有一种是特别的：

| | |
|---|---|
| Linux，无 root | `tmux new -d -s mahjong 'node server/server.js'`，或 `nohup node server/server.js >> var/server.log 2>&1 &` |
| Linux，有 root | `cp deploy/mahjong-relay.service /etc/systemd/system/ && systemctl enable --now mahjong-relay` |
| Windows | 在终端里跑，或者用任务计划程序配一个登录时触发 |

开奖任务随服务器重启是没问题的，而这正是让它按时钟运行的意义。截止之前每一次运行都是空操作，截止之后这个节奏同时也是恢复路径，对付三种不同的失败：

- **到点时 drand 连不上**（§8 —— 延迟，不是失败）。任务把 phase 留在 `awaiting_round`，下一个 tick 再试。快照在截止时就已冻结，所以延迟不可能改变结果。
- **进程在发布结果和同步到 Pantheon 之间死了。** 如果从来没有记录过同步结果，下一个 tick 会把它做完。`results.json` 只写一次，这一过程不碰它。
- **完成开奖之后 `var/` 丢了。** 任务读 `results.json`，把数据库对齐，然后停下。它不会重新开奖，也不会把一个已发布的轮次判作废。

一旦记录了一次同步**失败**，任务就停止重试：那条路径有人工补救手段（RUNBOOK 第 15 步），而一个每分钟砸一次 Pantheon 的定时器只会把它埋掉。

### 如果你想让别的东西来开奖

在 `data/runtime.json` 里把 `server.run_finalise` 设为 `false`，然后自己调度。用户级 crontab 同样不需要 root：

```
* * * * * cd /opt/mahjong/app && /usr/bin/node server/finalise.js --no-wait >> var/finalise.log 2>&1
```

不要两个都开。两场同时进行的开奖会得出一致的结果——任务是确定性的，这正是协议的全部要点——但它们会把提交名单盖两次戳，往 Pantheon 写两次，而外部副作用值得不做两遍。

### 万一没人在开奖，你怎么发现

这是一次真实发生过的失败，而且它是静默的：选手登录、封存数字、看着倒计时归零，然后什么都没发生。现在有三样东西会说话。

- 服务器为任务的每一次运行打印 `[schedule]` 日志行；如果 `run_finalise` 是关的、而且任务从未对着这个数据库跑过，启动时会有一条警告。
- `/admin` 里有一行 **The draw job has run**，附带上次运行时间。信标还没到时它是警告，开奖已经晚了时它是失败，而正是这一行区分开了「信标迟到」——等着——和「调度死了」——去把它启起来。
- 选手页面在两个间隔之后不再说「开奖中」，而是说开奖没有运行，并同时说明结果无论如何在截止时就已固定。

## 4. 反向代理

挑一个。两份配置做的是同样的三件事——终结 TLS、转发到 127.0.0.1:8080、设置安全响应头——而且它们不能并存，因为 :80 和 :443 只能被一个进程占住。

主机上已经跑着 nginx 的话用 **nginx**（`deploy/nginx.conf`），而 Pantheon 共用这台机器时必然如此：每个 Pantheon 容器都自带一个 nginx。在旁边再加一个 Caddy 不是冗余，是端口冲突。

```sh
cp deploy/nginx.conf /etc/nginx/sites-available/mahjong   # 先改域名
ln -s /etc/nginx/sites-available/mahjong /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

那两个端口上没有别的东西的主机用 **Caddy**（`deploy/Caddyfile`）。它会自己申请和续期证书，这正是它仍然被保留在这里的全部理由。

```sh
cp deploy/Caddyfile /etc/caddy/Caddyfile   # 先改域名
systemctl reload caddy
```

无论选哪个，有几件事是承重的：

- **这个流不能被缓冲。** Caddy 需要 `flush_interval -1`；nginx 会尊重应用已经发出的 `X-Accel-Buffering: no`（`server/events.js`），同时也配上 `proxy_buffering off`。没有它，等待阶段就停止更新，并静默退化为轮询。
- **`connect-src` 名单。** **浏览器**直接向 Frey 认证（`PANTHEON-INTEGRATION.zh.md` §2），所以必须把 Frey 的源加进去，否则登录会被 CSP 拦掉——而且拦掉的方式是任何服务器日志都记不下的，因为那个请求根本没到达任何服务器。
- **`data/runtime.json` 里的 `server.trust_proxy`。** 在代理后面，每个请求都来自 127.0.0.1，于是按来源的限流变成十二个人共享的一份限额——足以让几个人同时登录就把它用光。等代理设置了 `X-Forwarded-For` 之后把它设为 `true`；本目录里两份配置都设了。它默认关闭，是因为前面什么都没有时相信那个头，会让任何调用方编造一个地址就领走一份限额。应用读的是**最右边**那一项，也就是代理自己观察到的地址，所以伪造的前缀会被跨过去而不是被相信。当服务器监听在回环地址而这个设置是关的时，它在启动时会打印一条提示。

### 这里的 TLS 不是可选项

用明文 HTTP 提供服务，登录就会坏，而且坏的方式看起来不像是 TLS 问题。`NODE_ENV=production` 给会话 cookie 标上 `Secure`（`server/server.js`），而浏览器不会存储一个经由 `http://` 到达的 `Secure` cookie。选手登录了，页面往下走了，之后每一个请求都是未认证的。他的提交会以一个和他毫无关系的 401 失败。

还有第二个理由。浏览器把选手的 Pantheon 密码发给 Frey 自己。在 HTTP 上那个密码明文穿过网络，而它不是这场活动有权拿去冒险的东西——它是选手的 Pantheon 账号。

如果证书确实还拿不到，就用 `NODE_ENV=development` 在 HTTP 上把整套东西跑起来，**仅供测试**，并且要明白这个部署在这种状态下不适合跑一场真实抽签：`/api/dev-authorize` 在那里是存在的，而且它接受一个不带任何密码的 person id。

### 不要记录请求体

浏览器把选手的 Pantheon 邮箱和密码发给 Frey，并把拿回来的 token 发给 `POST /api/session`。两者都经过这个代理。nginx 默认不记录请求体，Caddy 也不——但一条带 `$request_body` 的 `log_format`，某个下午为了调一个登录问题加上去的，会把每位选手的 Pantheon 密码写进磁盘上的一个文件，以一种比这场活动活得更久、并且会随日志被到处复制的形式。

那个 token 也好不到哪里去。Frey 把它导出为 `sha384(password + salt)`，并且在密码改变之前一直接受它，所以它等价于密码（`PANTHEON-INTEGRATION.zh.md` §2）。应用只校验它一次，从不存储也从不记录；代理日志是它唯一还可能被捕获的地方。

如果你需要调试登录，现在失败会在页面上和上面那张表里自报家门。那就是它存在的意义。

## 5. 在把 URL 告诉任何人之前

```sh
curl -s https://your.domain/api/status | jq     # 12 个席位，submitted_count 为 0，phase 为 "open"
curl -s https://your.domain/protocol.json | jq  # 冻结参数，和打 tag 时一致
curl -s https://your.domain/api/dev-authorize -X POST -d '{}'   # 必须是 404
curl -s -o /dev/null -w '%{http_code}\n' https://your.domain/admin   # 必须是 404
```

然后打开 `/admin?token=…` 读起飞前面板。每一行都应当是绿的。`Mirroring to the repository: DISABLED` 和 `Pantheon adapter is the STUB` 这两条会让这个部署不适合跑真实抽签。

在那份 status 载荷里，`drand.chain_hash` 和 `drand.chain_public_key` 必须和打了 tag 的 `protocol.json` 完全一致——它们是浏览器用来钉死链的东西，只有两者都对，这场抽签才真的绑定在向所有人承诺过的那个信标上。`drand.api` 不需要和任何东西一致：它只是当前从哪里访问那条链（§4.2）。

然后自己登录试一次：用一个真实的、已报名这场活动的 Pantheon 账号，再用一个没报名的。两个答案都必须正确，而且读起来必须不一样（`UI-SPEC.zh.md` §3）。RUNBOOK 第 A3 步就是这项检查；现在做比到了正日子再做便宜得多。

## 6. 登录失败的时候

登录是唯一一个不经过这台服务器的请求。浏览器把邮箱和密码发给 Frey 自己（`PANTHEON-INTEGRATION.zh.md` §2），所以一次失败在这里的任何日志里都不留痕迹；而且很长一段时间里，页面把每一种失败都报成「邮箱或密码错误」——这让不止一个部署跑去查账号，而故障其实在一个 URL 上。现在页面把它们区分开了。它显示什么，以及该去哪里看：

| 选手看到的 | 实际发生了什么 | 去哪里看 |
|---|---|---|
| Pantheon 不认识这个邮箱和密码 | Frey 回答 `400 invalid_argument` | 确实是密码的问题 |
| Pantheon 里没有这个邮箱的账号 | Frey 回答 `404 not_found` | 他注册时用的那个地址 |
| 这次抽签的 Pantheon 地址配置有误 | `bad_route`，或者一个非 Twirp 的 404 | `runtime.json` → `pantheon.frey_base_url` 和 `twirp_path_template` |
| 连不上 Pantheon | 请求根本没得到任何回答 | CSP `connect-src`、混合内容、DNS、防火墙 |
| Pantheon 出错了 | Frey 返回 5xx | Frey 自己的日志；Hugin 挂掉会造成这个 |
| 这个账号没有报名本次活动 | Frey 说是，这台服务器说否 | 这个账号不在那十二人里 |

**绊倒大多数部署的**是第三行，而且它有一个具体的成因。`pantheon.frey_base_url` 是**后端**用的，本文件 §1 在 Pantheon 共用主机时把它指向 localhost 是对的。但**浏览器**拿到的也是同一个 URL，而且它要自己去调 Frey，在选手的手机上 localhost 就是那台手机。把 `pantheon.frey_public_url` 设成选手能解析的地址：

```json
{
  "pantheon": {
    "frey_base_url": "http://localhost:4004",
    "frey_public_url": "https://pantheon.example.com"
  }
}
```

当面向浏览器的那个 URL 是回环或私有地址时，服务器在启动时会警告，`/admin` 里也有对应的一行。那个源同样必须出现在代理的 CSP `connect-src` 里，否则请求在离开浏览器之前就被拦住了。

中间那四种情况还会在下面打印技术行——HTTP 状态码和 Twirp code——好让选手原样转发。

在正日子之前，对着一个真实的 Pantheon 把它们各复现一遍：

```sh
FREY=http://frey.pantheon.local:4004/v2/common.Frey/Authorize
curl -s -X POST $FREY -H 'content-type: application/json'   -d '{"email":"someone@example.com","password":"wrong"}'
# {"code":"invalid_argument","msg":"Password check failed"}
```

错误的服务名回答 `{"code":"bad_route",...}`，错误的版本前缀则完全错过 Twirp 路由器，拿到 nginx 的 HTML 404。两者含义相同：基础 URL 或者路径模板错了，改任何账号都修不好。

`tools/pantheon-fixture.js --accounts` 会在开发实例上建出十二个已知密码的账号，这样整条路径可以在它变得要紧之前先走一遍。
