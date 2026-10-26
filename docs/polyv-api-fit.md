# 保利威直播封面 API 对接

当前挂件只提供两个素材位置：

| 位置 | 生成规格 | 上传类型 | 装修字段 |
| --- | --- | --- | --- |
| 播放器封面 | 750×422 px，2 MB 以下 | `warmImage` | `player.warmUpImageUrl` |
| 引导页直播封面 | 1280×720 px，2 MB 以下 | `splashImage` | `splash.splashImageUrl` |

保存流程：通过[查询频道装修设置](https://help.polyv.net/live/api/v4/channel/decorate/get/)读取完整配置；调用[上传频道装修图片素材](https://help.polyv.net/live/api/web/setting/uploadimage/)取得保利威图片 URL；只替换目标字段并调用[修改频道装修设置](https://help.polyv.net/live/api/v4/channel/decorate/update/)；最后再次查询并核对新 URL。未选中的播放器、引导页字段和开关保持原值。

引导页后台当前提示图文布局与 PC 使用 16:9 图片，大图布局使用 9:16 图片。本项目只处理 16:9 横版，并保留 `splash.splashLargeImg` 原值。上传接口文档的旧版 `splashImage` 建议尺寸为 750×1334，与当前页面的横版提示不同；已用 1280×720 PNG 对真实 `splashImage` 上传接口验证成功。正式频道装修写入只在用户确认定稿后执行。

接口使用 `appId`、毫秒时间戳和服务端 `appSecret` 签名，遵循[保利威签名规则](https://help.polyv.net/live/api/buildSign/)。密钥只保存在服务端 `.env.local`。
