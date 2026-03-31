# Oracle ARM Bot

一个带 Web 控制台的 OCI ARM 抢机工具。应用会在容器内保存 OCI 凭据、抢机参数、任务状态和运行日志，并持续调用 `oci-cli` 尝试创建 `VM.Standard.A1.Flex` 实例。

## 功能简介

- 在页面中完成 OCI 凭据初始化，无需手动进入容器编辑配置文件
- 保存抢机参数并重复发起创建请求
- 实时查看任务状态和运行日志
- 日志优先通过 SSE 推送，体验接近实时；不支持时自动回退到轮询
- 抢机成功后自动停止任务

## 环境要求

### Docker 部署

- Docker
- Docker Compose

这是推荐方式。镜像内已经安装了 `oci-cli`，宿主机不需要额外安装。

### 本地运行

- Node.js 20+
- Python 3
- `oci-cli`

本地运行时，应用会直接调用系统里的 `oci` 命令，所以需要提前安装并可在命令行中执行。

## 目录与持久化

- `/app/data`：保存抢机配置、任务状态、日志文件
- `/root/.oci`：保存 OCI 配置文件和 API 私钥

如果使用项目自带的 `docker-compose.yml`，这两个目录都会通过 Docker volume 自动持久化。

## 部署方法

### 方法一：使用 Docker Compose

1. 进入项目目录。
2. 执行：

```bash
docker compose up --build -d
```

3. 打开浏览器访问 [http://localhost:3000](http://localhost:3000)。

查看运行状态：

```bash
docker compose ps
docker compose logs -f
```

停止服务：

```bash
docker compose down
```

如果你希望连同持久化数据一起清掉，再执行：

```bash
docker compose down -v
```

### 方法二：本地运行

1. 确认本机已安装 Node.js、Python 和 `oci-cli`。
2. 在项目目录执行：

```bash
npm start
```

3. 打开浏览器访问 [http://localhost:3000](http://localhost:3000)。

可选环境变量：

- `PORT`：监听端口，默认 `3000`
- `DATA_DIR`：应用数据目录，默认 `./data`
- `OCI_DIR`：OCI 配置目录，默认 `/root/.oci`

Windows PowerShell 示例：

```powershell
$env:PORT=3001
$env:DATA_DIR="C:\oci-bot-data"
$env:OCI_DIR="C:\oci-bot-oci"
npm start
```

## 试用方法

## OCI 初始配置从哪里获取

页面中的“OCI 配置初始化”需要以下 5 项：

- `Tenancy OCID`
- `User OCID`
- `Fingerprint`
- `Region`
- `Private Key`

可在 OCI 控制台按下面的方式获取：

- `Tenancy OCID`
  在控制台右上角头像菜单进入租户页面后查看
- `User OCID`
  在 `Identity & Security` -> `Users` -> 当前用户详情页中查看
- `Fingerprint`
  在当前用户的 `API Keys` 中上传公钥后获得
- `Region`
  使用你准备抢机的区域，例如 `ap-singapore-1`
- `Private Key`
  使用与你上传公钥配对的私钥内容，直接粘贴到页面文本框

如果你还没有 OCI API Key，可以先在本地生成一对密钥：

```bash
openssl genrsa -out oci_api_key.pem 2048
openssl rsa -pubout -in oci_api_key.pem -out oci_api_key_public.pem
```

然后按下面流程操作：

1. 打开 OCI 控制台，进入当前用户详情页。
2. 找到 `API Keys`。
3. 上传 `oci_api_key_public.pem` 的内容。
4. 记录控制台显示的 `Fingerprint`。
5. 将 `oci_api_key.pem` 的内容粘贴到页面中的 `Private Key`。

提示：

- 私钥内容通常以 `-----BEGIN PRIVATE KEY-----` 开头
- `Tenancy OCID` 和 `User OCID` 都必须是完整的 `ocid1...` 字符串
- 保存后可以点击页面中的“验证 OCI 配置”确认是否可用

### 第一次启动

1. 打开首页后，先在“OCI 配置初始化”中填写：
   - `Tenancy OCID`
   - `User OCID`
   - `Fingerprint`
   - `Region`
   - `Private Key`
2. 点击“保存 OCI 配置”。
3. 点击“验证 OCI 配置”，确认页面提示验证成功。

### 配置抢机参数

在“抢机任务配置”中填写以下内容：

- `Subnet ID`
- `Compartment ID`
- `Availability Domain`
- `Image ID`
- `Display Name`
- `OCPUs`
- `Memory (GB)`
- `Boot Volume (GB)`
- `Interval Seconds`
- `SSH Authorized Keys`

然后点击“保存抢机配置”。

### 启动试用

1. 点击“启动任务”。
2. 观察右侧两个区域：
   - “任务状态”：查看当前阶段、最后一次尝试时间、结果和错误信息
   - “运行日志”：实时查看发起请求、限流、库存不足、成功等日志
3. 如果页面上方显示日志流已连接，说明当前是 SSE 实时推送；如果显示轮询，则表示浏览器已回退到兼容模式。

### 停止试用

点击“停止任务”即可。停止后状态会切换为 `stopped`。

## 常见试用场景

### 验证 OCI 凭据是否正确

只填写并保存 OCI 配置，然后点击“验证 OCI 配置”。如果失败，日志里会记录失败原因。

### 用较短间隔做联调

可将 `Interval Seconds` 临时设为较小值，例如 `5` 或 `10`，方便观察状态切换和日志输出。正式使用时再改回更合适的重试间隔。

### 观察成功后的表现

当 OCI 返回成功响应后：

- 任务状态会变成 `success`
- 运行日志会写入成功记录
- 当前抢机任务会自动停止

## 运行机制说明

- 当前只支持一个运行中的抢机任务
- 每次尝试会调用 `oci compute instance launch`
- 如果返回包含容量不足信息，会进入等待并按间隔继续重试
- 如果返回限流信息，会按更长延迟继续重试
- 如果返回成功响应，任务结束

## 故障排查

### 页面打不开

- 确认服务已启动
- 确认端口 `3000` 没被占用
- 如果是 Docker 部署，先执行 `docker compose ps` 和 `docker compose logs -f`

### OCI 验证失败

- 检查 `tenancy`、`user`、`fingerprint`、`region` 是否正确
- 检查私钥内容是否完整
- 检查目标环境是否可以访问 OCI API

### 日志没有实时刷新

- 先看页面中的日志连接状态
- 如果浏览器支持 SSE，会自动走实时推送
- 如果连接中断，浏览器会自动重连
- 如果浏览器不支持 SSE，会自动回退到 `/api/logs` 轮询

## 快速命令

启动：

```bash
docker compose up --build -d
```

查看日志：

```bash
docker compose logs -f
```

停止：

```bash
docker compose down
```
