---
name: v8-api
description: 通过 V8 API 调用本站模型完成对话、图像或视频任务；先按密钥名称询问用户选择，不读取或展示密钥，不切换 Agent 当前会话模型。
---

# V8 API

仅在用户当前要求使用 V8 API 完成模型任务时调用。一个客户密钥可以访问本站全部模型；模型目录用于发现真实模型 ID 和接口类型。

## 凭据

- CLI 已将用户批准的密钥保存在本机凭据目录中。使用随本 Skill 安装的 `scripts/v8-api.mjs` 读取并发起请求；不要直接读取凭据文件、打印密钥、写入命令参数、环境变量、日志或对话。
- 运行 `node <Skill目录>/scripts/v8-api.mjs keys` 查看已绑定密钥名称。若有多把，先把名称展示给用户并让其选择；只有一把时直接使用。把选择的名称传给脚本的 `--key-name` 参数。
- 需绑定新密钥时，让用户在自己终端运行门户提供的一行 `npx` 命令；浏览器页面由用户登录并选择密钥，CLI 收到批准后仅保存所选密钥。不要请求用户把密钥粘贴到对话。
- 所有模型请求固定发送到 `https://api.v8.wiki`，禁止跟随重定向；脚本不会输出请求密钥。

## 发现模型并执行任务

先用所选密钥查询模型目录，再依据用户任务与模型返回的 `supported_endpoint_types` 选择真实模型 ID 和接口。通过 `scripts/v8-api.mjs models --key-name "<密钥名称>"` 查询。目录成功只证明目录可访问，不证明后续付费调用成功。

使用 `scripts/v8-api.mjs call --key-name "<密钥名称>" --method <GET|POST> --path <允许的本站接口>` 执行 API 请求。POST 的 JSON 请求体从标准输入传入，避免把凭据放在命令里。脚本只允许本站支持的模型接口，且会在出现重定向或 HTTP 错误时停止。

- 对话模型按目录接口类型调用 OpenAI Chat Completions、Responses、Anthropic Messages 或 Gemini 内容生成接口。
- 图像任务使用 `POST /v1/images/generations`，按目录所示的图像模型构造请求。
- 视频任务使用 `POST /v1/video/generations`；异步任务以 `GET /v1/video/generations/{task_id}` 查询，不要重复提交已发送但结果不明的生成请求。

只完成用户当前要求的任务，不为了验收额外发起可能计费的生成请求，不把一次任务广播给多个模型。不要修改 Agent 当前会话模型、默认 Provider 或其他客户端配置。
