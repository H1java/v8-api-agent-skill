# V8 API Agent Skill

用一条命令安装 Skill 并绑定一个具名密钥：

```sh
npx -y github:H1java/v8-api-agent-skill <USER_ID>
```

命令会把 Skill 安装到当前工作区 `.agents/skills/v8-api`，随后显示验证网址和用户码。登录 V8 API 网站，按密钥名称选择并确认。CLI 将选中的密钥保存在用户配置目录；再次运行可绑定其他密钥，同名密钥会更新。

API key 不会显示在终端或对话中。Skill 只列出已保存的密钥名称，多把密钥时由用户选择；模型请求只发送至 `https://api.v8.wiki`，并拒绝重定向。

需要 Node.js 20 或更新版本。当前命令使用 `H1java/v8-api-agent-skill` 作为 GitHub 仓库地址；仓库创建并推送、后端设备授权接口上线后，才能向客户分发和进行公网端到端验收。
