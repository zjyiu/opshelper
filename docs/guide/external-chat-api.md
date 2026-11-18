# 外部系统对话 API 调用手册

本文面向需要以某个 opshelper 用户的身份调用智能体的系统。调用方使用该用户创建的 API Token 指定用户，发送文本并获取回答；不需要也不能在对话请求中传入用户 ID。

## 1. 接入前准备

1. 部署包含外部对话接口的版本，应用数据库迁移并更新 nginx 配置。部署方法见[源码安装与更新](deployment.md)或[离线部署文档](offline-amd64.md)。
2. 确认目标用户已启用，已分配可作为主智能体的智能体，用户运行环境配置已就绪，且模型可用。
3. 通过 HTTPS 访问 opshelper 入口。下文用 `https://opshelper.example.com` 作为示例地址，实际调用时替换为部署地址。
4. 由目标用户登录，在聊天侧栏底部的用户菜单选择“API Token”，创建并复制自己的 Token，再通过安全渠道交给调用方；也可以按第 3 节使用接口创建。一个 Token 只对应一个用户，不能在请求中切换用户。

所有 JSON 请求使用 `Content-Type: application/json`。本文的 `<...>` 均为占位符，不是实际凭证或 ID。

## 2. 凭证说明

| 凭证 | 获取方式 | 用途 |
| --- | --- | --- |
| 登录会话 Token | 用户账号密码登录获得，或使用已登录浏览器 Cookie | 管理自己的 API Token、查看自己的主智能体 |
| API Token | 用户使用登录会话创建 | 调用 `/v1/integration/chat` 和 `/v1/integration/executions/{executionId}` |

两种 Token 不能互换。登录会话 Token 有有效期，返回的 `session.expiresAt` 表示到期时间；API Token 不自动过期。请求通过 `Authorization: Bearer <token>` 传递凭证，不要放进 URL。

API Token 代表用户执行任务，智能体可能使用该用户的工作区、工具和外部连接。只应交给可信系统，按系统分别创建 Token；不要写进源码、日志、工单或聊天记录。API Token 明文仅在创建时返回，服务端仅保存摘要；遗失后需要创建新 Token。撤销 Token 或停用用户后，后续请求无法认证，但已受理的执行不会自动停止。恢复旧数据库备份可能恢复当时尚未撤销的 Token，应重新检查并按需撤销或轮换。

## 3. 登录并创建 API Token

### 3.1 用户登录

使用目标用户自己的账号和密码：

```http
POST /v1/auth/login HTTP/1.1
Host: opshelper.example.com
Content-Type: application/json

{"username":"<用户名>","password":"<密码>"}
```

成功返回 HTTP 200，以下仅列出接入需要的字段：

```json
{
  "user": {"id": "<用户ID>", "username": "<用户名>", "name": "<显示名>", "role": "user"},
  "session": {
    "token": "<登录会话Token>",
    "tokenType": "Bearer",
    "expiresAt": "<ISO 8601时间>",
    "cookieName": "<Cookie名称>"
  }
}
```

后续管理请求使用 `session.token`，也可以使用该登录响应设置的 Cookie。账号密码错误返回 401，登录请求格式错误返回 400。

### 3.2 创建 Token

```http
POST /v1/users/me/api-tokens HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <登录会话Token>
Content-Type: application/json

{"name":"告警平台"}
```

`name` 为必填字符串，去除首尾空白后长度为 1～80。成功返回 HTTP 201：

```json
{
  "id": "<Token ID>",
  "name": "告警平台",
  "createdAt": "<ISO 8601时间>",
  "token": "<API Token>"
}
```

保存 `token` 供外部系统调用；保存 `id` 以便撤销。不要把上述响应写入普通日志。

### 3.3 查看和撤销 Token

查看仅返回当前用户自己的 Token 元数据，不返回明文：

```http
GET /v1/users/me/api-tokens HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <登录会话Token>
```

HTTP 200 示例：

```json
{"tokens":[{"id":"<Token ID>","name":"告警平台","createdAt":"<ISO 8601时间>"}]}
```

撤销：

```http
DELETE /v1/users/me/api-tokens/<Token ID> HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <登录会话Token>
```

成功返回 HTTP 204，无响应体。Token 不存在或不属于当前用户时返回 404；登录会话无效时返回 401。

### 3.4 查看可用主智能体

使用登录会话调用 `GET /v1/conversations`：

```http
GET /v1/conversations HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <登录会话Token>
```

响应中的 `agents` 数组包含当前用户可使用的主智能体，取其中的 `key` 作为对话请求的 `agentKey`。响应还包含 `conversations` 和 `executionBlockedReason`；不能使用 API Token 调用该接口。

## 4. 发送对话

```http
POST /v1/integration/chat HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <API Token>
Content-Type: application/json

{"agentKey":"network-ops","text":"请介绍你的能力"}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `agentKey` | 是 | 用户已分配、启用、检查就绪且可担任主智能体的 key；以小写字母开头，之后为小写字母、数字或 `-`，最多 64 个字符 |
| `text` | 是 | 非空文本，去除首尾空白后最多 100,000 个字符 |
| `conversationId` | 否 | 本用户已有会话 ID，长度 1～128；不传则新建会话 |
| `autoApprovePermissions` | 否 | 布尔值，默认 `false`；为本次执行的主智能体及子智能体工具请求自动选择“允许一次” |
| `stream` | 否 | 布尔值，默认 `false`；设为 `true` 时以 SSE 流式返回，见第 4.4 节 |

请求不接受额外字段。本接口不支持传入附件或指定模型，使用平台默认模型。执行进入该用户自己的队列，同一用户已有任务时可能需要排队。

自动授权只作用于本次执行，不建立永久允许规则；智能体提问、自动处理失败的授权仍需登录工作台处理。开启后可能自动允许修改文件、执行命令或访问外部资源，仅应在调用方可信且任务范围已确认时使用。

### 4.1 已完成：HTTP 200

```json
{
  "conversationId": "<会话ID>",
  "executionId": "<执行ID>",
  "status": "succeeded",
  "answer": "<智能体回答>"
}
```

`answer` 是本次执行的可展示文本，不包含模型推理。请保存 `conversationId` 用于多轮对话。

### 4.2 尚未完成：HTTP 202

接口在执行受理后最多等待约 45 秒，不包含创建会话和读取结果的时间；到时仍未完成会返回：

```json
{"conversationId":"<会话ID>","executionId":"<执行ID>","status":"running"}
```

`status` 可能是 `queued`、`dispatching` 或 `running`。使用返回的 `executionId` 查询结果，不要重新提交对话。接入方及外层代理的超时设置应大于等待时间，并为创建会话和读取结果留出余量；部署自带 nginx 的该接口读取超时为 120 秒。

### 4.3 多轮对话

下次请求传入之前返回的 `conversationId`，继续该用户已有的上下文：

```http
POST /v1/integration/chat HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <API Token>
Content-Type: application/json

{"agentKey":"network-ops","conversationId":"<会话ID>","text":"请继续详细说明"}
```

只能使用该用户自己的会话；已归档的本人会话也可以继续使用。每次 POST 都产生新的执行。

### 4.4 流式输出

请求中设置 `"stream": true`，可同时设置 `"autoApprovePermissions": true`：

```http
POST /v1/integration/chat HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <API Token>
Content-Type: application/json
Accept: text/event-stream

{"agentKey":"network-ops","text":"请分析问题","stream":true,"autoApprovePermissions":true}
```

流建立前的认证或参数错误仍返回普通 HTTP 错误和 JSON。任务受理后 HTTP 200、`Content-Type: text/event-stream`，响应依次包含 SSE 帧（每帧以空行结束，`data` 为 JSON）：

```text
event: accepted
data: {"conversationId":"<会话ID>","executionId":"<执行ID>"}

event: text
data: {"messageId":"<消息标识>","partId":"text:0","chunkId":1,"delta":"新增正文"}

event: operation
data: {"id":"operation-1","label":"读取文件","target":"README.md","status":"running"}

event: result
data: {"conversationId":"<会话ID>","executionId":"<执行ID>","status":"succeeded","httpStatus":200}

```

- 收到 `accepted` 后立即保存两个 ID。排队、运行状态通过最终 `result.status` 或第 5 节查询接口获取，流中不逐次发送状态轮询帧。
- `text` 只包含本次执行的主会话可展示文本，不含推理或子智能体正文。同一次执行中的助手文本共用一个 `messageId`；每个文本块有独立的 `partId`（如 `text:0`、`text:1`），不同执行会生成不同的 `messageId`。`chunkId` 从 `1` 开始，针对每组 `messageId` 与 `partId` 单独递增。相同组的 `delta` 是新增正文，按 `chunkId` 顺序追加；如收到 `text_replace`，按其递增的 `chunkId` 用 `text` 替换对应文本块。文本可能包括工具调用前的简短说明。
- `operation` 是本次执行的工具操作摘要，包含稳定的操作 `id`、概括性 `label`、可选 `target` 和 `status`；命令类操作的 `target` 会返回命令内容，最多 160 个字符，超长部分以 `…` 截断。相同 ID 的后续事件表示状态更新。它不包含工具输出或模型推理。
- 流式 `result` 只返回执行状态和 `httpStatus`，不重复包含最终回答；回答正文由 `text` 增量组成。`httpStatus` 对应第 5 节查询接口的状态码；`409` 表示需要在工作台处理交互，`502` 表示失败或无文本，`503` 表示结果暂不可读。状态读取期间如果交互已被处理，也可能返回 `202`；`404` 表示执行不存在或无法访问。收到 `result` 后流关闭；尚未完成、处理交互或暂不可读时使用执行查询继续获取结果。
- 流中断或状态读取出错会尽可能发送 `event: error`，包含 `conversationId`、`executionId` 和 `message`，然后关闭；HTTP 200 本身不代表任务成功。连接意外中断时也可能收不到 `error` 或 `result`。
- 空闲连接约每 15 秒发送一次以 `:` 开头的 SSE 心跳注释。流没有 45 秒等待上限，排队和运行期间保持连接；断开连接不会取消执行。该 POST 不支持 SSE 自动重连或事件重放：有执行 ID 时改用第 5 节查询，不要重新 POST。
- 服务端须使用包含本功能的 API 镜像和更新后的 nginx 配置；其他代理也须关闭 SSE 响应缓冲并允许长连接。

## 5. 查询执行结果

```http
GET /v1/integration/executions/<执行ID> HTTP/1.1
Host: opshelper.example.com
Authorization: Bearer <API Token>
```

使用与执行所属用户对应的 API Token 查询。响应状态及处理方式：

| HTTP | `status` | 含义和建议处理 |
| --- | --- | --- |
| 200 | `succeeded` | 已完成，读取 `answer` |
| 202 | `queued`、`dispatching`、`running` | 尚未完成；等待后再次查询，建议间隔数秒 |
| 409 | `waiting_input` | 智能体正在等待用户回答或未处理的工具授权；登录工作台处理后继续查询。接口没有交互回复功能 |
| 502 | `failed`、`cancelled`、`interrupted` | 执行失败、取消或状态无法确认；查看 `message`，必要时在工作台核对 |
| 502 | `succeeded` | 执行完成但没有可展示的文本回答；查看 `message` |
| 503 | `succeeded` | 执行完成但暂时无法读取回答；稍后重试查询 |
| 401 | 无 | Token 缺失、无效、已撤销或用户已停用 |
| 404 | 无 | 执行不存在或不属于该用户 |

有执行结果的响应包含 `conversationId`、`executionId` 和 `status`；失败响应通常包含 `message`。等待交互的示例：

```json
{
  "conversationId": "<会话ID>",
  "executionId": "<执行ID>",
  "status": "waiting_input",
  "message": "Execution requires user input or permission in the workspace"
}
```

## 6. 错误与重试

- HTTP 400：参数不符合要求、包含多余字段，或指定的智能体不能作为主智能体。检查 `message` 和请求内容。
- HTTP 401：检查使用的是正确类型的 Token，以及凭证和用户是否有效。
- HTTP 403：智能体未分配给该用户、已停用或未通过检查；联系管理员或检查智能体配置。
- HTTP 404：会话或执行不存在，或者不属于 Token 对应用户。
- HTTP 409：除等待交互外，也可能表示会话需要恢复；查看 `message`，在工作台处理。
- HTTP 429：容器启动处于冷却期；按响应提示处理。
- HTTP 503：运行环境或结果读取暂不可用。若响应包含 `executionId`，只查询该执行；否则先检查工作台和响应原因。

**POST 没有幂等保证，也不支持客户端提供请求标识。** 每次 POST 都可能创建并执行一条新任务。收到 202 或其他带 `executionId` 的响应后，应查询已有执行而不是重新 POST。如果网络断开、客户端或代理超时且没有拿到 `executionId`，任务仍可能已受理；先登录该用户工作台核对，避免重复执行带来副作用。查询接口可以重试。

## 7. curl 示例

以下示例使用 Bash，在安全终端中输入 API Token（输入不回显）。变量和响应中可能包含敏感信息；不要开启 shell 跟踪，不要在共享终端、普通日志或工单中粘贴凭证和回答。示例通过标准输入向 curl 提供认证头，避免把 Token 放在 curl 命令行参数中。

```bash
BASE_URL="https://opshelper.example.com"
read -rs -p "API Token: " OPSHELPER_API_TOKEN
printf '\n'

printf 'header = "Authorization: Bearer %s"\n' "$OPSHELPER_API_TOKEN" |
  curl --config - --silent --show-error --max-time 120 \
    -H 'Content-Type: application/json' \
    --data '{"agentKey":"network-ops","text":"请介绍你的能力"}' \
    --write-out '\nHTTP status: %{http_code}\n' \
    "$BASE_URL/v1/integration/chat"
```

若返回 202，使用返回的执行 ID 查询：

```bash
EXECUTION_ID="<执行ID>"
printf 'header = "Authorization: Bearer %s"\n' "$OPSHELPER_API_TOKEN" |
  curl --config - --silent --show-error --max-time 30 \
    --write-out '\nHTTP status: %{http_code}\n' \
    "$BASE_URL/v1/integration/executions/$EXECUTION_ID"
```

流式调用可用 `curl --no-buffer` 实时读取 SSE：

```bash
printf 'header = "Authorization: Bearer %s"\n' "$OPSHELPER_API_TOKEN" |
  curl --config - --no-buffer --silent --show-error \
    -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
    --data '{"agentKey":"network-ops","text":"请分析问题","stream":true,"autoApprovePermissions":true}' \
    "$BASE_URL/v1/integration/chat"
```

使用完毕后可执行 `unset OPSHELPER_API_TOKEN`。示例不自动重试 POST；如需生产集成，应妥善处理上述各类状态及连接中断。
