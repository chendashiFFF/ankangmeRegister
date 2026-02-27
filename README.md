# invite-console-express

一个简易 Web 控制台：

1. 使用手机号+验证码调用登录接口
2. 从登录响应提取 token
3. 用 token 调用填写邀请码接口
4. 返回执行明细和统计

## 1) 安装和启动

```bash
cd /Users/apple/invite-console-express
npm install
npm run dev
```

打开 `http://localhost:3000`

## 2) 配置你的接口

编辑 `config/api.config.json`。

关键字段：

- `login.token_path`: token 在登录响应里的路径，例如 `data.token`
- `login.success_rule`: 成功判断，例如 `code==0`
- `invite.success_rule`: 成功判断，例如 `code==0`
- `invite.token`: token 放 header 还是 body

支持模板变量：

- `{{phone}}`
- `{{code}}`
- `{{invite_code}}`
- `{{token}}`
- `{{device.xxx}}`

## 3) 页面输入

- 邀请码
- 设备 JSON（可选）
- 手机号和验证码（每行 `phone,code`）

## 4) 说明

- 当前按顺序串行执行，避免过快触发风控。
- 仅适合你自己的合法业务测试。
