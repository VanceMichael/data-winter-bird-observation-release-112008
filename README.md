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
