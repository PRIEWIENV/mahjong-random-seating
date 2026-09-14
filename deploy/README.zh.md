# 部署指南

> [English](README.md) · 简体中文

组织者要做的一切，按顺序，从一台空服务器到一场办完的抽签。涉及两台机器：**你的电脑**，在这里冻结活动（需要构建工具链）；**服务器**，活动在这里运行。第一次预留一个下午，之后半小时。[`../docs/RUNBOOK.zh.md`](../docs/RUNBOOK.zh.md) 是同一套流程压成的一页清单，第二次用。

命令都完整给出。需要填你自己的值的地方用 `<尖括号>`。各步骤背后的理由不在这里；最后一节说明它们在哪。

> [!IMPORTANT]
> **开始之前你需要**
> - 两台机器上都有 **Node 24 或更新**（`node --version`）。更老的版本能装上，第一次启动就失败。
> - 一个选手们在上面有账号的 **Pantheon** 实例，以及上面一个是该活动管理员的管理员账号。
> - 一个**你能推送的 git 仓库**——你自己 fork 的这个仓库。冻结会把你的活动提交进去，选手拿到的是那个 tag。
> - 一个指向服务器的**域名**，用于 TLS。明文 http 上登录不了。
> - 服务器上：只有 nginx 和 certbot 需要 `sudo`。应用本身不需要 root，不需要新用户，不占 1024 以下的端口。
> - 网络：两台机器都能到 `api.drand.sh`，服务器能到 Pantheon，选手的手机能直接到 Frey（Pantheon 的登录服务）。

## 第一部分——活动之前，在你的电脑上

### 1. Pantheon 里的活动

在 Pantheon 的管理界面里：

1. 创建或打开活动，标为 **prescripted**（必须是 tournament，不能是 club 活动——只有 tournament 能 prescripted）。
2. 报名**恰好十二名**选手。到场但不打的人标 `ignore_seating`。
3. 给十二个人每人一个 **local id**，1 到 12。
4. 确认之后座位表同步要用的管理员账号是**这场活动的**管理员。

记下活动 id；冻结时要用一次。

### 2. 你的仓库

```sh
git clone <你的 fork> mahjong-random-seating && cd mahjong-random-seating
npm ci
cp data/runtime.example.json data/runtime.json
```

编辑 `data/runtime.json` → `pantheon`：把 `frey_base_url` 和 `mimir_base_url` 设成你的 Pantheon 的 Frey 和 Mimir 地址。冻结要从 Mimir 读名册，所以这台电脑必须能访问它们。

> [!NOTE]
> `runtime.json` 被 gitignore，永远不进 tag，所以每台机器上要各写一份。§6 在服务器上还会再写一次。

### 3. 选定目标轮次

```sh
cp data/protocol.example.json data/protocol.json      # 只有第一场活动需要
node tools/pick-round.js --in 72h --write
```

`--in 72h` 把开奖放在 72 小时之后，提交截止在开奖前十分钟。它从运行中的 drand 链上取值，把 `target_round`、`submission_cutoff_utc`、`chain_hash` 和 `chain_public_key` 一起写好。

### 4. 冻结并打 tag

```sh
node tools/freeze.js --event <id> --write             # data/roster.json，从 Pantheon 读出
node tools/freeze.js --write --tag <name> --push      # 提交、打 tag、推送；打印通告
git ls-remote --tags <你的 fork> <name>               # 在任何别的机器上：tag 是公开的
```

第一条命令在下面任一情况下拒绝——并且什么都不写：入座人数不是十二，有人没有 local id 或没有名字，有账号重复报名。去 Pantheon 里改好再跑一次。

第二条大约要一分钟：它重新推导座位模板的不变量，从源码重新构建浏览器 bundle 并与已提交的比对，跑单元测试，然后提交 `data/protocol.json`、`data/roster.json`、`data/schedule_template.json`、`generate.js` 和构建出的 bundle，打 tag，推送，并给 commit id 盖时间戳。它还会打印第 10 步要用的**通告**——现在就复制下来。

> [!WARNING]
> - `<name>` 只用一次。第二场活动，或者作废后的重试，都要新名字。
> - 保存 `events/freeze/<name>.commit.ots`。它证明这个 commit 在任何人提交之前就存在。
> - 从这里起，冻结的东西一个都不能改。改一个字节，活动作废。

## 第二部分——服务器

### 5. 在 tag 上安装

```sh
git clone <你的 fork> ~/mahjong && cd ~/mahjong
git fetch --tags && git checkout <tag>                # 第 4 步的那个名字
npm ci --omit=dev
node tools/build-client.js --verify-hash              # 已提交的 bundle 和它的哈希一致
```

> [!NOTE]
> - `--omit=dev` 是有意的：服务器只需要 `tlock-js`，别的都不需要。
> - 全新克隆上 `--verify-hash` 失败的话，跑 `git check-attr text eol -- public/app.js`。它必须说 `-text`；不是的话，是 git 改写了行尾，错的是检出，不是 bundle。

### 6. 配置

**`.env`**，放在 checkout 根目录。进程自己读它，不管是谁启动的：

```sh
PORT=8080
HOST=127.0.0.1
NODE_ENV=production
PANTHEON_MODE=twirp

# 镜像：每一份密文一到达就发布到仓库里。
# 这三行不要手填 —— `node tools/setup-mirror.js` 会替你写好，见下。
MIRROR_REPO=<owner>/<repo>
MIRROR_BRANCH=main
MIRROR_TOKEN=github_pat_...

# 可选 —— 组织者面板，在 /admin?token=...  （openssl rand -hex 16）
# 通常不需要：任何一位活动管理员用普通页面登录后，就能用自己的会话打开面板。
# 只有当你想要一个「还没人登录时也能用」的链接、或想从一台没登录的机器打开时才设它。
ADMIN_TOKEN=...
```

```sh
chmod 600 .env
```

#### 镜像用的 GitHub token

```sh
node tools/setup-mirror.js          # 问你、验证能用、写进配置
node tools/setup-mirror.js --check  # 以后随时检查 token 是否还有效
```

跑起来它会从 `git remote origin` 认出仓库，告诉你该点哪里，用隐藏输入接收 token，**先实际验证它真的能写**，通过之后才把 `MIRROR_REPO`、`MIRROR_BRANCH`、`MIRROR_TOKEN` 以 `600` 权限写进 `.env`。全程不用手改文件，token 也不会出现在命令行或 shell 历史里。

唯一替不了你的是 GitHub 那一步：token 是 GitHub 发给真人的，需要在浏览器里签发，没有任何 API 能凭空生成一个。（OAuth device flow 要一个注册好的 OAuth App，那会让每一个跑这份代码的人都依赖那个 App 的所有者，而且照样要你去 github.com 上输一串码。）所以这一步做一次就好，打开 [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)，或者走菜单：Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → **Generate new token**：

| 字段 | 填什么 |
|---|---|
| Token name | 随便，比如 `seating mirror` |
| Expiration | 晚于开奖那天 |
| Resource owner | 拥有镜像仓库的那个账号或组织 |
| Repository access | **Only select repositories** → 你的 fork |
| Permissions | Repository permissions → **Contents** → **Read and write** |

点 Generate token，复制那串 `github_pat_…`，GitHub 只显示这一次。回到终端粘贴即可。如果这台机器上已经装了 [GitHub CLI](https://cli.github.com/) 并且登录着，工具会问你要不要直接用 `gh auth token`，那样连浏览器都不用开——代价是那是你整个账号的 token，而不是只限这一个仓库的，对一个要长期放在服务器上的凭证来说不划算。

> [!NOTE]
> 那次验证是真的写入：它会在分支上建一个 `.mirror-check` 再删掉，留下两个 commit。这是故意的。`GET /repos` 返回的是**用户**的权限而不是 token 的权限，所以一个只读 token 用在你自己的仓库上看起来也是可写的——而真正会发现这件事的，是提交窗口期间某位选手的那一份提交。加 `--no-probe` 可以跳过，工具会明说这一项没验。

> [!WARNING]
> 镜像正是「密文一到达就公开、并由组织者控制不了的第三方打上时间戳」这件事（PROTOCOL.md §5）。不设 `MIRROR_REPO`/`MIRROR_TOKEN` 服务器照样能跑——它会打印 `[mirror] disabled` 并把东西都只留在本地——但你会失去那个阻止组织者在看到结果之后丢掉一份不合意提交的东西。正式活动不要这样跑。

> [!NOTE]
> **不用再去弄 Pantheon 管理员 token。** 把座位表写回 Pantheon 需要一个「管理这场活动」
> 的账号。你不必找出它的 token 再粘到这里：当一位活动管理员通过普通页面登录时，服务器
> 会认出他（Frey `GetOwnedEventIds`）、给他显示组织者面板、并把同步要用的 token 就地捕获
> —— 以 `0600` 存在 `var/` 里，不写日志、不进仓库。所以唯一的要求是**开奖前有一位活动
> 管理员登录过一次**，而组织者本来就会登录。用
> `node tools/check-signin.js --email you@example.com` 的第 3b 步可以确认你自己的账号符合
> 条件。如果你更想用一个固定的服务账号，就在 `.env` 里设 `PANTHEON_ADMIN_PERSON_ID` 和
> `PANTHEON_ADMIN_TOKEN`，它会优先于自动捕获的那份。
> Frey 的 token 永不过期，所以关闭活动（§14）会把捕获的那份删掉。

**`data/runtime.json`**：

```sh
cp data/runtime.example.json data/runtime.json
```

在 `pantheon` 下设置：`frey_base_url` 和 `mimir_base_url`，按服务器访问它们的地址；`frey_public_url`，按**选手的手机**访问 Frey 的地址——一个 `https://` 地址。在 `server` 下：`"trust_proxy": true`。

> [!WARNING]
> `frey_public_url` 是选手浏览器登录时要连的地址。只在服务器上能解析的名字（`*.local`、`localhost`、局域网地址）在每一部手机上都会失败。服务器启动时看到这样的值会警告，`/admin` 上也有对应的红行。

**如果 Pantheon 用 Docker 跑在同一台机器上**，它的服务只认自己的主机名，而服务器上没有任何东西会解析那些名字，除非你加上：

```sh
echo '127.0.0.1  mimir.pantheon.local frey.pantheon.local' | sudo tee -a /etc/hosts
getent hosts mimir.pantheon.local        # 必须打印出 127.0.0.1
```

用 `getent` 检查，不要用 `curl`。即便如此，`frey_public_url` 仍然必须是公网地址：手机不在这台机器上。

### 7. TLS 和反向代理

证书文件不存在时 nginx 不会加载配置，而 nginx 在 80 端口为这个域名应答之前 certbot 又发不出证书。所以：先 80 端口那一半，再证书，再完整配置。

```sh
sudo cp deploy/nginx-bootstrap.conf /etc/nginx/sites-available/mahjong   # 改 server_name
sudo ln -s /etc/nginx/sites-available/mahjong /etc/nginx/sites-enabled/
sudo mkdir -p /var/www/html && sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/html -d <你的域名>
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mahjong             # 要改的地方见下
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run --deploy-hook 'systemctl reload nginx'
```

第二次 `cp` 之前，在 `deploy/nginx.conf` 里改：

- 每一处 `example.com` → 你的域名（三处：两个 `server_name`，证书路径）；
- `Content-Security-Policy` 那一行的 `connect-src` 里加上你的 `frey_public_url` 的源，例如 `connect-src 'self' https://userapi.example.org https://api.drand.sh ...`。不加的话，浏览器在请求离开手机之前就把登录拦下，任何日志里都看不到。

> [!NOTE]
> 文件里已经设了 `X-Forwarded-For` 和 `X-Forwarded-Proto`。两个都必需：前者让每位选手有自己的限流额度，后者是服务器得知请求经过 TLS 的方式。自己写的 nginx 配置必须两个都设。

<details>
<summary><b>用 Caddy 代替 nginx</b>——只在没有别的东西占着 80 和 443 端口的机器上</summary>

<br>

```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile     # 改域名和 connect-src
sudo systemctl reload caddy
```

Caddy 自己申请和续期证书，两个转发头也都会设。

</details>

### 8. 启动

一个进程。它提供页面，也用自己的定时器开奖；不需要另外调度任何东西。

选一种：

| | 命令 | 重启后还在 |
|---|---|---|
| 先试试 | 在终端里 `node server/server.js` | 否 |
| Linux，无 root | `tmux new -d -s mahjong 'node server/server.js'` | 否 |
| **Linux，无 root（推荐）** | 下面的用户单元 | 是 |
| Linux，有 root | `sudo cp deploy/mahjong-relay.service /etc/systemd/system/ && sudo systemctl enable --now mahjong-relay`——先改里面的路径 | 是 |

用户单元：

```sh
mkdir -p ~/.config/systemd/user
sed "s|@CHECKOUT@|$PWD|g" deploy/mahjong-relay.user.service > ~/.config/systemd/user/mahjong-relay.service
systemctl --user daemon-reload
systemctl --user enable --now mahjong-relay
loginctl enable-linger                                # 注销之后也继续跑
loginctl show-user "$USER" -p Linger                  # 必须是 Linger=yes
journalctl --user -u mahjong-relay -f                 # 日志
```

不管选了哪种，日志开头几行必须有这三行，并且不能出现 STUB 这个词：

```
[server] listening on http://127.0.0.1:8080
[server] pantheon: TwirpPantheon
[server] running server/finalise.js every 60s (server.run_finalise)
```

> [!NOTE]
> - `enable-linger` 之后仍是 `Linger=no`，说明这台机器需要管理员跑一次 `loginctl enable-linger <你>`；不然你一注销服务就停。
> - 8080 被占了（同时跑着 Pantheon 的机器上很常见）？把 `.env` 里的 `PORT` 和 nginx 文件里的 `proxy_pass` 改成同一个数。
> - 停止：`systemctl --user stop mahjong-relay`，或 Ctrl+C。正在进行的开奖会被留到做完。

### 9. 公布之前先检查

在任何地方：

```sh
curl -s https://<你的域名>/api/status | head -c 300      # "phase":"open"，12 个席位，submitted_count 0
curl -s https://<你的域名>/protocol.json | head -c 300   # 冻结参数，和 tag 里的一样
curl -s -X POST https://<你的域名>/api/dev-authorize      # 必须是 404
curl -s -o /dev/null -w '%{http_code}\n' https://<你的域名>/admin   # 必须是 404
```

然后打开 `https://<你的域名>/admin?token=<ADMIN_TOKEN>`。起飞前检查面板每一行都必须是绿的。让部署不适合办真实抽签的两行是 **Mirroring to the repository: DISABLED** 和 **Pantheon adapter is the STUB**。

面板上那一行只能说明配置项存在。要确认 token 现在仍然写得进去——token 会过期，fine-grained 的那种也可能因为组织改了策略而丢掉仓库：

```sh
node tools/setup-mirror.js --check       # 只读 .env，什么都不改
```

然后用你自己的 Pantheon 账号在页面上登录一次。失败的话，在任何装了 Node 的机器上：

```sh
node tools/check-signin.js --email <你的邮箱> --event <id>   # 会问密码，不打印任何机密
node tools/check-signin.js --admin --event <id>              # 同步用的凭据，在只读能检查的范围内
```

第一条把登录要经过的三步走一遍，说出哪一步失败、页面本来会显示什么。第二条确认管理员 token 有效、活动能应答；写权限只有同步本身才能证明。

## 第三部分——活动

### 10. 公布

把冻结时打印的通告（第 4 步）发给选手：地址；一个 0 到 255 之间的数字，只提交一次；页面说已封存就可以关掉；开奖什么时候；tag 和 commit id。所有人同一个链接——没有个人链接，没有 token。他们用已有的 Pantheon 账号登录。

### 11. 窗口期间

没有要运行的东西。`/admin` 按名字列出还没提交的人，选手端页面显示同样的计数。临近截止时催一催。

> [!WARNING]
> - 12 人里至少 8 人提交，否则这次尝试作废，所有人重新提交（§15）。这个数是冻结的；当天不商量。
> - 不在十二人里的人不能在窗口期间加进来。诚实的做法是作废，用正确的十二人重新冻结。
> - 盯着起飞前检查面板。窗口期间有一行变红，现在就处理，别等开奖之后。

### 12. 开奖

截止时服务器固定并公布提交名单。信标的目标轮次到达时——默认设置下是十分钟后——开奖在一分钟内自动进行。然后：

1. `/admin` 显示结果：`round_used`、R、种子、排列，以及 `results.json` 的摘要。选手的页面自己显示座位表。
2. `results.json` 和 `events/` 已在仓库里（镜像）。
3. 同步面板说座位表已写入 Pantheon 并读回——Pantheon 的管理界面里也能看到。

**如果同步失败**：开奖仍然是最终的，`results.json` 说了算。打开 `results.json`，复制 `pantheon_prescript` 字段，贴进 Pantheon 里这场活动的 prescript，用 `WIND_SHUFFLE_MODE_PRESCRIPTED` 应用。别的风位模式会把座位模板保证的大部分东西扔掉。**绝不重新开奖。**

### 13. 选手可以自己核验什么

结果页会把这一段填好打印出来。任何人都能做，在一台从没见过服务器的机器上：

```sh
git clone <你的 fork> draw && cd draw
git checkout <tag>                                   # 通告里的 tag
git checkout origin/HEAD -- results.json events/     # 冻结之后才写的，所以不在 tag 里
node generate.js --verify results.json               # 每一个字节，外加对着截止快照的点名核对
python3 tools/verify_template.py data/schedule_template.json
```

> [!NOTE]
> 第三行取的是开奖通过镜像（§6）发布出去的文件。镜像关着的话，`results.json` 和 `events/` 只存在于服务器上，谁也核验不了——这正是 `/admin` 拒绝把这样的部署称为「就绪」的原因。

### 14. 收尾

在下一次冻结**之前**，不是之后：

```sh
node tools/end-event.js --dry-run     # 它会归档和清理什么
node tools/end-event.js
```

它把这次尝试——密文、截止时的名单、结果、同步结果、它运行时的冻结文件——归档到 `events/rounds/<target_round>/`，验证每一个摘要，然后才清理 `var/` 和 `events/` 下的现场文件。归档验证不过，什么都不清理。先把服务器停掉（`systemctl --user stop mahjong-relay`）。

它还会删掉 `var/admin-credential.json`，也就是登录时捕获的管理员 token，这个文件从不被归档、也从不被镜像。Frey 的 token 不会过期，所以它跟着活动一起走，而不是留在盘上。下一场活动会重新捕获一份。

> [!WARNING]
> 先冻结下一场，这一场的 `protocol.json` 就会在归档之前被覆盖。工具会发现并说出来，但证据就不完整了。而且在收尾之前，服务器会拒绝为下一场启动，而不是把上一场的座位表端出来。

## 第四部分——参考

### 15. 出问题的时候

**登录。** 页面会说出失败的是什么；下面是每一种的含义和该看哪里。

| 选手看到的 | 发生了什么 | 去哪里看 |
|---|---|---|
| Pantheon 不认识这个邮箱和密码 | Frey 回答 `400 invalid_argument` | 确实是密码的问题 |
| Pantheon 里没有这个邮箱的账号 | Frey 回答 `404 not_found` | 他注册时用的那个地址 |
| 这次抽签的 Pantheon 地址配置有误 | `bad_route`，或者非 Twirp 的 404 | `runtime.json` → `pantheon.frey_public_url`、`twirp_path_template` |
| 连不上 Pantheon | 浏览器没从 Frey 得到任何回答 | CSP `connect-src`（§7）、混合内容、DNS、防火墙 |
| Pantheon 出错了 | Frey 返回 5xx | Pantheon 自己的日志 |
| 这个账号没有报名本次活动 | Frey 说是，这台服务器说否 | 这个账号不在那十二人里 |
| 连不上抽签服务器（不是 Pantheon） | nginx 回了 502/504，或者根本没有应答 | 服务器在跑吗？它的日志（§8），然后是 nginx 的 error log |
| 登录尝试太频繁 | 这台服务器回答 429 | `trust_proxy` 不是 `true`（§6）：所有人共用一份额度 |
| 这个页面是用 http 打开的 | 生产模式，而代理没有报告 https | TLS（§7）；代理配置里的 `X-Forwarded-Proto` |
| 登录成功，但浏览器没有保存会话 | 登录后紧接着的 `GET /api/me` 回答 401 | 浏览器：cookie 被禁用，隐私窗口 |
| 抽签服务器出错了 | 这台服务器返回 500 | 这台服务器的日志，里面有完整的栈 |

除了前两行和「没有报名」那一行，其余每一种都会在下面打印技术行，选手可以原样转发。`tools/check-signin.js --email`（§9）能在任何机器上把 Pantheon 那一半复现一遍。

**管理面板样式全部没渲染出来**，控制台不停报 *"Applying inline style violates the following Content Security Policy directive"*。`/admin` 的响应上带着**两个** CSP 头——应用自己的，和反向代理加的——浏览器会同时执行这两个，真正生效的是它们的交集。检查你的代理配置里 `style-src` 和 `script-src` 是否仍然列着 `'self'`；如果哪一条被收紧到去掉了它，那么无论应用发什么，`/admin.css` 都会被拦下。用这两条确认：`curl -sI https://<你的域名>/admin.css`（应为 `200` 和 `text/css`），以及 `curl -sI 'https://<你的域名>/admin?token=<ADMIN_TOKEN>' | grep -i content-security`（应为两行，两行都允许 `'self'` 作为样式来源）。

**提交不足 8 人。** 任务把这次尝试判为作废，公布 `events/void.json`，把一切归档到 `events/rounds/<target_round>/`。什么都不删。然后按顺序：

1. `node tools/new-round.js --dry-run`——确认归档完整。
2. 在你的电脑上：`node tools/pick-round.js --in 72h --write`，然后 `node tools/freeze.js --write --tag <新名字> --push`（§3–§4）。还是这十二个人。
3. 在服务器上：`git fetch --tags && git checkout <新名字>`，然后 `node tools/new-round.js`。它重新验证归档，清掉现场的提交，开启新一轮。第 2 步没做它会拒绝。
4. 通知选手：新的 tag，**全部十二人**重新提交（旧密文绑定在过期的那一轮上），以及作废的那次公布在哪里。

**开奖时连不上 drand。** 等。任务每分钟重试；结果在截止时就已经定了，不会变。

**某个 drand 镜像挂了，或者 Pantheon 搬家了。** 改 `data/runtime.json`，重启服务器。冻结的东西一点没动，所以不用重新打 tag，也不用通告。

**服务器死了，或者 `var/` 没了。** 再启动一次。开奖已经公布的话，它从 `results.json` 恢复状态，绝不重新开奖，也不会把这一轮判作废。同步没记录的话，下一个 tick 把它做完。

**没有人在开奖。** `/admin` 上 **The draw job has run** 那一行说明定时器上一次什么时候跳的。从来没跳过：看日志里的 `[schedule]` 行，并确认 `runtime.json` 里 `server.run_finalise` 不是 `false`。如果你是自己调度的，crontab 那一行是 `* * * * * cd ~/mahjong && node server/finalise.js --no-wait >> var/finalise.log 2>&1`。别两个一起跑。

### 16. 下一场活动

先收尾这一场（§14），然后从 §1 重新开始，用新的活动 id，第 4 步用新的 tag 名字。服务器上，§5 的 `git fetch --tags && git checkout <tag>` 会拿到新的冻结；§6–§8 照旧。

### 17. 为什么是这样

理由都在 [`../docs/IMPLEMENTATION_NOTES.zh.md`](../docs/IMPLEMENTATION_NOTES.zh.md) 里：不用 root 和用户单元（§6n），安装顺序和为什么 tag 在前（§6r、§6s），谁来开奖（§6j），停止时允许打断什么（§6l、§6m），收尾流程（§6o），hosts 记录和 ENOTFOUND 那条消息（§6x），runtime 文件（§6y），TLS 和登录页说的话（§6z）。什么是冻结的、为什么，在 [`../docs/PROTOCOL.zh.md`](../docs/PROTOCOL.zh.md) §4；信任论证在那里的 §9 和 §10。
