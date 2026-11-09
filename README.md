# V8 API Agent Skill

用一条命令安装 Skill 并绑定一个具名密钥：

```sh
npx -y --package https://v8api.wiki/skills/v8-api-agent-skill.tgz v8-api-agent-skill <USER_ID>
```

命令会把 Skill 安装到当前工作区 `.agents/skills/v8-api`，随后显示验证网址和用户码。登录 V8 API 网站，按密钥名称选择并确认。CLI 将选中的密钥保存在用户配置目录；再次运行可绑定其他密钥，同名密钥会更新。

API key 不会显示在终端或对话中。Skill 只列出已保存的密钥名称，多把密钥时由用户选择；模型请求只发送至 `https://api.v8.wiki`，并拒绝重定向。

需要 Node.js 20 或更新版本。安装包由 `v8api.wiki` 提供；设备授权还要求生产 API 已部署 `/api/agent-skill/device` 接口。
