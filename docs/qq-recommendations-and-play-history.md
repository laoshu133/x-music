# QQ 个性化推荐与播放历史架构

## 背景

XMusic 过去使用公共歌单搜索近似实现“QQ 每日推荐”，并在“QQ 猜你喜欢”私有接口解析失败时退化为收藏歌手搜索。播放历史则通过 `sdk.fcg + webcomm + cmd=25` 模拟上报，且没有实现 QQ 最近播放拉取。

这些近似方案不能保证结果来自当前用户的 QQ 个性化数据。本方案以 QQ 音乐 iOS 客户端抓包和 XMusic 开发环境真实授权验证为依据，替换上述实现。

## 目标

- “QQ 猜你喜欢”只展示当前 XMusic 用户对应 QQ 帐号的 `id=99` 电台内容。
- “QQ 每日推荐”从当前用户的推荐 Feed 动态发现歌单，再读取真实个人歌单。
- 播放开始后使用 QQ 最近播放写接口同步记录。
- 支持将 QQ 最近播放拉取到 XMusic 本地历史。
- 所有授权、缓存和本地历史继续以 `user_id` 隔离。
- QQ 私有接口不可用时返回明确错误，不再以公共内容冒充个性化内容。

## 身份与数据边界

`user_id` 是 XMusic 内唯一的业务所有权键，用于本地播放历史、收藏、Emby 映射和同步任务。

`qq_uin`、QQ Cookie、QQ Music Key 仅存在于当前用户的 `qq_authorizations` 记录和 QQ 协议请求中。客户端不能通过请求参数指定其他 UIN，业务数据表也不能使用 UIN 作为所有权键。

请求链路必须先解析当前 XMusic 会话，再读取该用户的 `AccountRecord.qqCookie`。管理员与普通用户遵循相同规则。

## 已验证接口

核心接口统一通过带签名的 JSON 请求调用：

```text
POST https://u.y.qq.com/cgi-bin/musics.fcg?sign=...
Cookie: 当前用户的 QQ Cookie
```

### QQ 移动设备会话

QQ iOS 抓包和开发环境真实授权复验表明，猜你喜欢虽然仍使用 `radioProxy`，但不能只携带 Web Cookie 直接请求。客户端会先建立一个短期移动设备会话：

```text
module: music.getSession.session
method: GetSession
param: { uid: "", vkey: 0, caller: 0 }
```

请求使用 Android 客户端上下文，并从当前用户 Cookie 中读取 `qm_keyst/qqmusic_key` 作为 `comm.authst`。响应中的 `req.data.session.uid` 和 `sid` 是 QQ 协议设备会话标识，不是 XMusic `user_id`，也不是 QQ UIN；它们只能用于随后发往 QQ 的协议请求，不能进入业务数据所有权字段。

设备会话按当前 QQ UIN 与 MusicKey 指纹隔离，在进程内缓存 23 小时。设备标识和 `uid/sid` 不写入数据库；服务重启、MusicKey 变化或 QQ 返回会话错误时重新获取。这样既避免每个 5 首批次都多一次握手，也不会在不同用户之间复用登录上下文。

### QQ 猜你喜欢

```text
module: music.radioProxy.MbTrackRadioSvr
method: get_radio_track
param: {
  id: 99,
  num,
  from: 0,
  scene: 0,
  song_ids: [],
  should_count_down: 0,
  ext: { 播放器前后台状态、最近播放状态等 }
}
```

请求 `comm` 使用移动端 `ct=11/cv=14090008`，携带当前 QQ 的 `authst` 以及上一步取得的 `uid/sid`。旧实现使用 Web `ct=24/cv=4747474` 且没有设备会话，线上会稳定返回 `req.code=1000` 和空 `tracks`；该现象不是整份 QQ Cookie 只有猜你喜欢一项过期。

歌曲位于 `req.data.tracks`。旧接口兼容字段 `Tracks`、`songlist`、`v_song` 和 `list` 可以保留解析，但 `tracks` 是当前真实响应的主要字段。

该电台接口单次最多返回 5 首，`num=30` 仍只返回 5 首。XMusic 必须根据单页目标数量动态计算预计批次数 `ceil(num / 5)`，持续请求并按 `source + songmid` 去重，直到达到目标数量。为容纳偶发重复，可在预计批次数之外保留少量额外尝试；某批没有新增歌曲时立即停止，QQ 返回业务错误时直接失败，不能无限重试。

猜你喜欢限制的是每页数量，不是歌单总量。Web API 和 Emby/Ampcast 的单页 `Limit` 默认值和上限均为 30；Emby 初始使用 `TotalRecordCount=999` 表示结果仍可继续分页，接近该位置时总量提示会随当前页继续增长。该数值只是未知总量的客户端兼容提示，不是业务总数上限。由于 QQ 每批实际仅返回约 5 首，30 首通常需要 6 次串行请求；不能改为无约束并发，否则会触发 QQ 业务限流。

Emby 推荐结果使用按 `user_id` 隔离的 60 秒内存池。连续翻页复用已有结果，每次请求最多新增 30 首；直接跳到较大 `StartIndex` 时只加载目标页，不补抓中间页面。相同页在缓存有效期内直接复用，避免 Ampcast 重复刷新产生额外 QQ 请求。上游扩展失败时，仅当目标页已有缓存歌曲才返回缓存；首屏没有任何缓存时必须透传错误，不能伪装成成功的空列表。

QQ 批次请求保持串行，避免并发调用触发 `req.code=700000`。首次设备会话握手与歌曲请求共用单批超时预算；单批默认超时 4 秒、整次聚合默认超时 12 秒。超时时已有结果则返回部分歌曲，没有任何结果才返回 504。慢请求和超时会记录请求数量、批次数、耗时与停止原因，不记录 Cookie、MusicKey、`uid/sid` 等授权和协议会话信息。

超时和诊断参数可通过环境变量覆盖：

```text
QQ_RECOMMENDATION_BATCH_TIMEOUT_MS=4000
QQ_RECOMMENDATION_TOTAL_TIMEOUT_MS=12000
QQ_RECOMMENDATION_SLOW_LOG_MS=5000
```

worker 的 QQ 授权巡检仍会在启动时执行，`checked=1, active=1, expired=0, failed=0` 表示授权正常。健康汇总默认不再打印；需要诊断时可设置 `X_MUSIC_QQ_AUTH_SWEEP_LOG_HEALTHY=true`，发现过期或失败时始终保留日志。

### QQ 每日推荐

第一步读取当前用户推荐 Feed：

```text
module: music.recommend.RecommendFeed
method: get_recommend_feed
```

从 `req.data.v_shelf[].v_niche[].v_card[]` 中选择标题为“每日30首”“每日推荐”或同义名称的卡片，读取其 `id`。歌单 ID 必须动态发现，不能硬编码，也不能跨用户缓存。

第二步读取歌单：

```text
module: music.srfDissInfo.DissInfo
method: CgiGetDiss
param: { disstid, song_begin: 0, song_num: limit, ... }
```

歌曲位于 `req.data.songlist`。iOS 的 `mobileCgiGetDiss` 使用不同的二进制参数协议，XMusic 不实现该协议；已验证 JSON 版本 `CgiGetDiss` 可以读取同一真实个人歌单。

### 最近播放写入

```text
module: music.musicasset.PlayRecentlyWrite
method: ReportPlayRecentlyInfo
param: {
  data: [{
    id: "QQ numeric song id",
    type: 2,
    lastTime: Unix 秒,
    listenCnt: 1
  }]
}
```

`type=2` 表示歌曲。播放器只有在确认发生播放开始时才写入，Range 请求从非零偏移继续读取时不能重复写入。

每日推荐和猜你喜欢的来源记录可分别使用 `type=4 + playlistId` 与 `type=5 + id=99`，但它们不是歌曲最近播放同步的必要条件，本期不写入，避免额外改变 QQ 推荐画像。

### 最近播放读取

```text
module: music.musicasset.PlayRecentlyRead
method: GetPlayRecentlyInfo
param: { type: 2, count: limit }
```

歌曲位于 `req.data.data.songList`，每项包含 `track`、`lastTime` 和 `listenCnt`。XMusic 将 `track` 映射为共享曲目元数据，并以当前 `user_id` 和 `lastTime` 写入 `play_events`。

QQ 最近播放只提供每首歌的最近时间和累计次数，不能还原每一次播放的准确时间。因此拉取时每首歌只导入一条最近事件，不根据 `listenCnt` 伪造历史事件。`play_events` 现有的用户、曲目、质量和时间检查保证重复拉取幂等。

### 播放状态

```text
module: music.richFlag.listening
method: ListeningMusicReport
```

该接口可以使用当前授权调用，但它是实时状态补充，不是最近播放的权威写入。本期不要求播放器持续上报它。

## 应用调用链

### Web API

```text
XMusic 会话
  -> AccountRecord.qqCookie
  -> QQ 推荐/历史协议接口
  -> QQSong 映射
  -> 当前用户的 API 响应或 play_events
```

- `GET /api/recommendations?type=guess` 返回真实猜你喜欢。
- `GET /api/recommendations?type=daily` 返回真实每日推荐。
- `GET /api/history?sync=pull&remote=qq` 拉取 QQ 最近播放并返回合并后的本地历史。
- `POST /api/history?sync=push&remote=qq` 将当前用户的本地最近播放写回 QQ。

### Ampcast / Emby

Emby 虚拟歌单请求已经解析为具体 `AccountRecord`。猜你喜欢和每日推荐必须使用该帐号 Cookie，不能读取全局 Cookie。虚拟音频只在初始请求或 `Range: bytes=0-...` 时记录播放并触发 QQ 写入。

## 错误与降级

- 缺少 QQ 授权：返回 `QQ_AUTH_REQUIRED`，不请求公共替代数据。
- QQ 返回非零业务码：记录经过脱敏的业务码并返回系统错误。
- 猜你喜欢在已缓存设备会话下返回 `req.code=1000`：先废弃 `uid/sid` 并重新建立设备会话；新会话仍失败时，才进入 MusicKey 刷新流程。
- 猜你喜欢在新设备会话下仍返回 `req.code=1000/104400/104401`：判定为该能力所需凭据异常，强制刷新 MusicKey 并重试一次。重试仍失败时只返回 `QQ_RECOMMENDATION_AUTH_REQUIRED`，不影响每日推荐、收藏等其他 QQ 功能；相同 Cookie 在 10 分钟内不重复执行慢刷新。只有刷新流程自身明确返回 401 时，才将当前用户的整体 QQ 授权标记为过期。
- QQ 猜你喜欢聚合超过批次或总时限：已有歌曲时返回部分结果，否则返回 504。
- Feed 中找不到每日推荐卡片：返回明确的每日推荐不可用错误。
- 个性化接口返回空列表：视为接口异常，不回退到公共榜单或歌手搜索。
- QQ 历史拉取失败：保留本地历史，不删除或覆盖已有事件。
- QQ 历史后台写入失败：不阻断音频播放；显式同步接口返回失败明细。

QQ 原生 VKey 与本方案无关。当前请求协议仍会收到 `104009 / invalidq`，音频地址继续由现有 LX URL 服务解析。

## 验收标准

- 两个绑定不同 QQ 的 XMusic 用户获取到彼此独立的猜你喜欢和每日推荐。
- 猜你喜欢在首次请求时先建立移动设备会话，后续批次和缓存有效期内不重复握手。
- MusicKey 变化或缓存会话失效后重新获取 `uid/sid`，且这些协议会话字段不写入业务数据表。
- 猜你喜欢成功响应中的小写 `tracks` 能正确映射。
- 猜你喜欢按单页请求数量动态聚合 5 首批次，单页最多返回 30 首且不会无限请求。
- Ampcast 首次请求 5 首时收到可继续分页的估算总量，后续每页最多新增 30 首。
- Ampcast 重复读取缓存页不会再次调用 QQ，直接跳页也不会补抓中间所有页面。
- 每日推荐歌单 ID 来自当前用户 Feed，不出现硬编码 ID 或公共搜索。
- 播放一首包含 numeric `songId` 的歌曲后，QQ 最近播放可读回该记录。
- 相同 QQ 历史重复拉取不会生成重复的本地事件。
- `remote=qq` 拉取只写入当前 `user_id`。
- QQ 写入不再依赖播放 URL，也不再调用 `sdk.fcg + cmd=25`。
- 个性化接口失败时不会返回标记为个性化的公共替代内容。
