# External Service 开发与部署规范

> 本文保留 HTTP Provider 的部署规范。CLI Provider、传输无关 capability、stdio 协议和生命周期扩展见 [Service Provider Framework](./provider-framework.md)。

本文定义 Store、Memory、Security 等独立服务如何通过 Feature SDK 接入 Bibit。平台只管理连接、认证和协议边界，不实现模块业务逻辑。

## 1. 固定架构

```text
Feature 插件
  -> @bibit/feature-sdk capability
  -> Bibit Tauri External Service Gateway
  -> POST <baseUrl>/bibit/v1/invoke
  -> 模块 Adapter
  -> 模块自有后端
```

插件不得直接 `fetch` 模块后端，不得读取服务 URL、端口或凭据。模块后端不必采用 Python、C++ 或任何指定框架，只需由模块团队提供符合本文协议的 Adapter 入口。

## 2. 职责边界

| 所有者 | 必须负责 | 不应负责 |
| --- | --- | --- |
| Bibit 平台 | capability grant、连接发现、认证注入、超时、请求/响应校验、统一错误 | operation 业务语义、模块 DTO 转换 |
| 模块团队 | Adapter、operation/DTO、后端 API 映射、服务进程和升级兼容 | 修改 Bibit 私有代码、在插件保存凭据 |
| 插件前端 | 使用公开 capability、展示局部加载和错误状态 | 直连后端、伪造生产数据、宣称 capability 等于服务健康 |

operation ID 和 DTO 必须在模块仓库中只有一个事实来源。插件、Dev Host Mock、Adapter 和协议测试共同消费或逐项同步该契约；任何一处结构不同都视为不兼容。兼容字段只能新增为可选字段，删除、重命名或改变含义必须发布新的 operation 版本。

## 3. Gateway 协议

入口固定为：

```text
POST <baseUrl>/bibit/v1/invoke
Content-Type: application/json
```

请求示例：

```json
{
  "protocolVersion": 1,
  "requestId": "host-generated-id",
  "serviceId": "security",
  "operationId": "agents.list.v1",
  "params": {},
  "timeoutMs": 30000
}
```

成功和业务失败都使用 HTTP 2xx，并回显相同 `requestId`：

```json
{
  "protocolVersion": 1,
  "requestId": "host-generated-id",
  "ok": true,
  "result": {}
}
```

```json
{
  "protocolVersion": 1,
  "requestId": "host-generated-id",
  "ok": false,
  "error": {
    "code": "unavailable",
    "message": "Service is unavailable",
    "retryable": true
  }
}
```

允许的错误码为 `cancelled`、`offline`、`timeout`、`unauthorized`、`incompatible`、`unavailable`、`provider_crashed`、`resource_exhausted` 和 `unknown`。破坏性 DTO 变更必须发布新的 operation ID，例如从 `agents.list.v1` 升级为 `agents.list.v2`。

## 4. 连接发现与优先级

正式系统包为每个模块安装独立 drop-in：

```text
/etc/bibit/external-services.d/security.json
/etc/bibit/external-services.d/agenthub.json
/etc/bibit/feature-capability-grants.d/security.json
/etc/bibit/feature-capability-grants.d/agenthub.json
```

文件格式：

```json
{
  "version": 1,
  "services": {
    "security": {
      "baseUrl": "http://127.0.0.1:5185",
      "requestTimeoutMs": 30000,
      "authRef": "optional-credential-reference"
    }
  }
}
```

加载顺序从低到高为：

1. `/etc/bibit/external-services.d/*.json`，按文件名排序；
2. Bibit 用户数据目录的 `external-service-connections.json`；
3. Debug 构建中的 `BIBIT_EXTERNAL_SERVICE_CONFIG` 文件。

高优先级中相同 `serviceId` 覆盖低优先级配置。单个损坏的 system drop-in 只会被忽略并记录日志，不影响其他模块。所有有效来源都缺失或没有服务时，Gateway 返回 `unavailable`。

`serviceId` 使用最长 64 字符的 kebab-case；新增合法 ID 不需要改动或重编 Bibit，但必须同时在 `/etc/bibit/feature-capability-grants.d/<module>.json` 登记 `service:<serviceId>` capability 和该 Feature 的 operation grant。

`authRef` 只保存凭据引用；实际 token 由 Bibit 凭据存储读取。禁止把 token 写入 drop-in、Manifest、URL、插件参数或日志。

## 5. 平台开发验证

修改 Registry 或 Gateway 后运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml external_services::tests
```

测试必须覆盖：

- system drop-in 合并；
- 用户和 Debug 覆盖顺序；
- 损坏文件隔离；
- URL、operation、敏感 transport 字段和响应信封校验；
- 真实 HTTP 转发、主动取消、超时和响应大小限制。

插件界面中的“已连接”只能由一次真实业务请求成功后显示。仅取得 capability 时应显示“集成已启用”或“正在连接”。

## 6. 模块部署规范

模块的安装包负责安装自己的 Adapter、systemd 服务和 drop-in；不得修改其他模块的文件，也不得从维护脚本写入某个用户的 home 目录。

推荐布局：

```text
/usr/lib/<module>/adapter
/usr/lib/bibit/plugins/<feature>.bibit-plugin.tgz
/etc/bibit/external-services.d/<service>.json
/usr/lib/systemd/system/<module>-bibit-adapter.service
```

安装后执行：

```bash
systemctl daemon-reload
systemctl enable --now <module>-bibit-adapter.service
```

Adapter 默认只监听 loopback。systemd 的 `active` 只说明进程尚未退出，不代表已经完成鉴权或能够调用业务后端；安装和升级脚本必须在服务启动后执行一次 `/bibit/v1/invoke` 业务探针。服务依赖应通过 unit 的 `Wants=`/`After=` 声明，不在插件前端轮询或启动后端。

升级顺序固定为：先部署兼容新旧 operation 的 Adapter，探针通过后再替换签名插件 bundle，最后重启 Bibit 并执行真实页面验收。回滚必须恢复匹配的 Adapter、bundle 和 drop-in，不能只回滚前端。

卸载时只删除本模块拥有的文件。配置文件如有管理员修改，应按 Debian conffile 规则保留或提示。

## 7. 接入验收

必须分别证明以下四层，不能互相替代：

1. 模块后端进程和监听存在；
2. Adapter 的 `/bibit/v1/invoke` 回显 `requestId`；
3. Bibit 实际加载了对应 Registry 条目并完成 operation 调用；
4. 插件页面显示真实持久数据，停止 Adapter 后只局部失败。

以下证据不能互相替代：插件日志中的 `Loaded trusted plugins`、systemd `active`、端口监听、curl 协议成功、Bibit 页面真实数据。交付记录必须明确每一层是否通过。

最小协议探针：

```bash
curl -fsS http://127.0.0.1:5185/bibit/v1/invoke \
  -H 'Content-Type: application/json' \
  --data '{"protocolVersion":1,"requestId":"smoke-1","serviceId":"security","operationId":"agents.list.v1","params":{},"timeoutMs":30000}'
```

响应必须包含相同的 `requestId`。只看到插件已加载、capability 已授权或端口可连接，都不能视为端到端通过。

## 8. 故障排查顺序

1. 检查插件 Manifest capability 和平台 grant；
2. 检查 `/etc/bibit/external-services.d/` 和用户覆盖配置；
3. 检查 Adapter systemd 状态与监听；
4. 直接调用 `/bibit/v1/invoke`；
5. 检查 operation ID、DTO 和 `requestId`；
6. 检查 `authRef` 对应凭据是否存在；
7. 最后检查插件局部错误展示。

不要通过在插件中硬编码 `http://127.0.0.1:<port>` 绕过 Gateway。
