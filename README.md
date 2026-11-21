# 越冬观测的批次收集与公开位置撤回

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可通过 `SOURCE_PORT` 设置端口，也接受通用的 `PORT`，同时设置时以 `SOURCE_PORT` 为准。`GET /health` 用于确认来源服务已就绪。来源使用进程内演练时钟，启动时处于 `walk`。用 `PUT /_source_clock?step=partial` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `walk`、`partial`、`attach`、`reconcile`、`expire`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

`/north/patrol?cursor=0` 的条目包括完成巡线区间和随巡线提交的观测。`/east/sets` 为采集批清单，指向各段入口及附件，`declaredParts` 是完整批应含的段数。两个来源内的观测身份是组织和观测号的组合，定位附件是 `observation` 的补件。 `/patrol/areas` 定义要求巡到的距离区间，单位米，端点采用半开区间。
`/registry/links` 是合作组织核验过的同次观察登记，`/registry/permissions` 是针对观测记录的独立许可。位置网格代码的前两位为片区、前四位为粗格，完整六位为细格；时间可取整小时、整天（UTC）。`bound` 是从生效时刻起对同次公开项的发布限制，`grant` 允许使用该条证据，`unbind` 停止此前的限制，`revoke` 撤回原记录的公开使用许可。所有字段和编号均为合成。`/subscribers/acks` 是已确认的续取范围。

## 本地合成应用

`npm run app` 启动巡护办公室的本地应用（先 `npm start` 起来源，或用 `SOURCE_BASE` 指向已有来源）。默认监听 `http://127.0.0.1:4183`，可用 `APP_PORT`（或 `PORT`）改端口；启动前先探测来源 `/health`。应用不引入第三方依赖，全部状态保存在进程内账本，重启即清空。

每轮通过 `POST /internal/sync`（可选 `{"stage":"walk|partial|attach|reconcile|expire"}` 或显式 `asOf`）重新拉取两个来源、许可流和订阅确认，并重新核对覆盖与发布。阶段与演练时刻的对照在 `app/sync.mjs` 的 `STAGE_AS_OF`，许可生效判断一律以该时刻为准。

### 内部巡护视图（`/internal`）

- `GET /coverage` 按路线给出要求片区、各巡护员实际走完区间、缺口米数与缺口原因（缺页/缺附件）。覆盖只认 `walked` 区间，观测定位不补足覆盖。
- `GET /facts` 事实台账：`missing-part`（清单缺页）、`missing-attachment`（定位附件未到）、`explicit-zero`（明确记录到零只），各自独立，带 `open/resolved/recorded` 生命周期。
- `GET /observations` 与 `GET /observations/:item` 合作方有效明细，含同号补件/更正（`revises`）/取消的版本史、附件待补状态、所属同次观察事件，以及该记录当前的公开使用权（含 `embargoUntil`）。
- `GET /links` 已核对的同次观察关联，以及仅供人工处理的未核对近似候选（粗格相同、时间相差不超过 30 分钟）；未核对记录绝不自动合并。
- `GET /rounds` 与 `GET /rounds/:n` 每轮巡护派出时使用的证据快照。
- `GET /duty/withdrawals` 按订阅方确认范围列出尚未送达的撤回通知。

### 公开出口（`/public`）

- `GET /catalog` 当前仍有效的公开发布，只含合成许可共同允许的网格位数与时间桶。
- `GET /feed?from=<发布号>` 按发布号续取，含撤回通知；已撤回的历史发布在流中变为 `redacted`，不携带任何旧定位或更细网格线索。
- `GET /withdrawals` 撤回通知清单，只有发布号、被撤发布号和原因。

发布规则：同次观察只在一个联合粒度下公开一个定位；任一来源同时生效的更严 `bound` 收窄共同粒度，`embargoUntil` 未结束时整条等待窗口；单条 `revoke` 只撤该条证据，其余成员许可按生效时段独立判断；粒度变化、定位更正、合并或取消一律先发撤回再以新发布号发布，旧细格不会出现在目录、历史补发、迟到附件或撤回消息里。内部凭据访问公开出口同样无法恢复已撤定位。

