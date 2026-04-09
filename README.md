# AgenticSRE — 多智能体协作智能运维系统

> 基于"发现-假设-规划-调查-推理"范式的多智能体运维系统

## 项目概述

AgenticSRE 是一个面向通算与智算场景的高效率、可解释、自演化的智能运维系统。
系统通过多智能体协作实现从"被动响应"向"主动诊断与自适应进化"的跨越。

### 核心特性

- 🔍 **主动故障检测**：多维度持续监控（指标/日志/调用链/事件/告警）
- 🧠 **假设驱动RCA**：基于"发现→假设→规划→调查→推理"五阶段范式
- 🤖 **多智能体协作**：专用智能体编排协作，支持链式/反应式/并行模式
- 📊 **告警压缩与根因推荐**：语义化告警聚合，根因推荐准确率≥80%
- 🔄 **持续演化**：WeRCA式记忆学习 + 专家反馈 + 历史轨迹优化
- 👁️ **全链路可观测**：输入/输出/思维链/性能/资源 端到端可观测
- 🛠️ **自动修复**：安全的自愈操作 + ActionStack回滚机制

### 系统架构

```
                    ┌──────────────────────────────────────┐
                    │         AgenticSRE Web Dashboard      │
                    │     (FastAPI + SSE Real-time Push)     │
                    └──────────────┬───────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────┐
                    │         Orchestrator Layer             │
                    │  ┌─────────┐ ┌──────────┐ ┌────────┐│
                    │  │ Pipeline│ │  Daemon   │ │  RCA   ││
                    │  │ Manager │ │ (7×24)    │ │ Engine ││
                    │  └─────────┘ └──────────┘ └────────┘│
                    └──────────────┬───────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
    ┌────▼─────┐            ┌─────▼──────┐           ┌─────▼──────┐
    │ Detection │            │  Planning   │           │  Recovery   │
    │  Agents   │            │  & Reasoning│           │   Agent     │
    │           │            │  Agents     │           │             │
    │• Alert    │            │• Hypothesis │           │• Remediation│
    │• Metric   │            │• Correlation│           │• ActionStack│
    │• Log      │            │• RCA Judge  │           │• Rollback   │
    │• Event    │            │             │           │             │
    └────┬─────┘            └─────┬──────┘           └─────┬──────┘
         │                         │                         │
    ┌────▼─────────────────────────▼─────────────────────────▼──────┐
    │                        Tool Layer                              │
    │  K8s Ops │ Prometheus │ Elasticsearch │ Jaeger │ Anomaly Det  │
    └────┬─────────────────────────┬─────────────────────────┬──────┘
         │                         │                         │
    ┌────▼─────────────────────────▼─────────────────────────▼──────┐
    │                   Memory & Evolution Layer                     │
    │  FaultContextStore │ ContextLearner │ RCAJudge │ TraceStore   │
    └───────────────────────────────────────────────────────────────┘
```

## 五阶段 Pipeline

| 阶段 | 名称 | 描述 |
|------|------|------|
| Phase 1 | **DETECTION** | 持续轮询Prometheus告警、K8s事件、ES错误日志、指标异常 |
| Phase 2 | **HYPOTHESIS** | 生成初始根因假设，注入历史知识 |
| Phase 3 | **INVESTIGATION** | 多智能体并行证据收集 + 交叉信号关联 + 假设重排序 |
| Phase 4 | **REASONING** | 图推理RCA定位 + LLM综合报告 + 质量评估 |
| Phase 5 | **RECOVERY** | 条件触发自愈操作 + 回滚保护 |

## 快速开始

### 方式一：本地运行

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 配置
cp configs/config.example.yaml configs/config.yaml
# 编辑 config.yaml 配置LLM、K8s集群、可观测性后端

# 3. 启动Web Dashboard
cd web_app && ./run.sh

# 4. 命令行模式
python main.py --mode daemon     # 7×24持续监控
python main.py --mode pipeline   # 单次Pipeline
python main.py --mode rca --query "pod CrashLoopBackOff in namespace default"
```

### 方式二：Docker 部署

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 LLM API Key 等配置

# 2. 一键部署
bash deploy_docker.sh

# 3. 重新构建镜像（修改代码后）
bash deploy_docker.sh --build

# 4. 停止服务
bash deploy_docker.sh --stop
```

部署完成后访问 `http://localhost:8080` 即可使用 Web Dashboard。

> **注意**：首次部署会自动构建 Docker 镜像（约 2-5 分钟）。如果存在 `agenticsre-image.tar.gz` 离线镜像包，将优先从包加载，使用 `--build` 参数可强制重新构建。

## AliData 离线模式

当 `observability.backend: "alidata"` 且 `offline_mode: true` 时，系统不会连接线上阿里云接口，而是直接读取本地离线数据目录。

离线数据来源于阿里天池比赛论坛：

- https://tianchi.aliyun.com/competition/entrance/532387/forum

离线模式相关配置位于 `configs/config.yaml`：

```yaml
observability:
  backend: "alidata"
  offline_mode: true
  offline_data_dir: "/path/to/dataset"
  offline_problem_id: "002"
  offline_data_type: "failure"  # auto | baseline | failure
```

字段含义：

- `offline_data_dir`：离线数据根目录，目录下按 `problem_xxx` 组织
- `offline_problem_id`：当前读取的数据集编号，例如 `002`
- `offline_data_type`：读取的数据类型，`baseline` 表示基线时段，`failure` 表示故障时段，`auto` 表示由系统自动选择

数据目录格式如下：

```text
AliData/data/
├── problem_002/
│   ├── baseline_logs.json
│   ├── baseline_metrics.json
│   ├── failure_logs.json
│   ├── failure_metrics.json
│   ├── failure_traces.json
│   ├── metadata.json
│   └── metrics.png
├── problem_003/
│   └── ...
└── problem_xxx/
    └── ...
```

其中：

- `baseline_logs.json` / `baseline_metrics.json`：基线时段的日志与指标数据
- `failure_logs.json` / `failure_metrics.json` / `failure_traces.json`：故障时段的日志、指标与调用链数据
- `metadata.json`：问题编号、时间窗口、下载时间等元数据
- `metrics.png`：该问题对应的指标可视化截图

离线模式下通常将 `offline_data_dir` 指向 `AliData/data`，再通过 `offline_problem_id` 切换到具体的 `problem_xxx` 数据集。


## 项目结构

```
AgenticSRE/
├── main.py                  # 主入口
├── mcp_server.py            # MCP Server (Claude/Copilot集成)
├── requirements.txt         # Python依赖
├── Dockerfile               # Docker镜像构建
├── docker-compose.yaml      # Docker Compose编排
├── deploy_docker.sh         # 一键Docker部署脚本
├── configs/                 # 配置文件
├── agents/                  # 智能体模块
│   ├── alert_agent.py       # 告警压缩与根因推荐
│   ├── metric_agent.py      # 指标分析
│   ├── log_agent.py         # 日志分析
│   ├── trace_agent.py       # 调用链分析
│   ├── event_agent.py       # K8s事件分析
│   ├── hypothesis_agent.py  # 假设生成与重排序
│   ├── correlation_agent.py # 交叉信号关联
│   ├── detection_agent.py   # 持续异常检测
│   ├── planning_agent.py    # 规划智能体
│   ├── remediation_agent.py # 自愈智能体
│   └── profiling_agent.py   # Profiling分析
├── tools/                   # 工具层
│   ├── base_tool.py         # 工具基类 + 注册器
│   ├── k8s_tools.py         # K8s操作工具
│   ├── k8s_ops.py           # K8s SDK原生操作
│   ├── observability.py     # Prometheus/ES/Jaeger
│   ├── anomaly_detection.py # 异常检测算法
│   ├── hero_analysis.py     # Hero分析引擎
│   ├── rca_localization.py  # 图推理RCA
│   ├── action_stack.py      # 操作回滚栈
│   └── llm_client.py        # LLM客户端
├── memory/                  # 记忆与演化
│   ├── fault_context_store.py  # 故障上下文存储
│   ├── context_learner.py      # 自动规则学习
│   ├── rca_judge.py            # RCA质量评估
│   └── trace_store.py          # 执行轨迹存储
├── orchestrator/            # 编排层
│   ├── rca_engine.py        # 核心RCA引擎
│   ├── pipeline.py          # 五阶段Pipeline
│   ├── daemon.py            # 7×24守护进程
│   └── session.py           # 会话状态管理
├── observability/           # 智能体可观测性
│   ├── tracer.py            # 执行追踪器
│   ├── metrics_collector.py # 性能指标收集
│   └── validator.py         # 行为验证器
├── web_app/                 # Web Dashboard
│   ├── app.py               # FastAPI后端
│   ├── templates/           # Jinja2模板
│   └── static/              # 前端资源
└── eval/                    # 评估模块
    ├── benchmark_runner.py  # 基准测试运行器
    └── eval_tasks.yaml      # 测试任务定义
```

## SOW 交付对照

| SOW要求 | AgenticSRE对应模块 | 状态 |
|---------|-------------------|------|
| 面向智算/通算的专用智能体 | agents/ (8个专用Agent) | ✅ |
| 告警压缩与根因推荐 | agents/alert_agent.py | ✅ |
| 多智能体协作范式 | orchestrator/ (Pipeline/Daemon) | ✅ |
| 多智能体行为可观测性与验证 | observability/ (Tracer/Validator) | ✅ |
| 假设推理的持续演化 | memory/ + orchestrator/rca_engine.py | ✅ |
| 根因推荐准确率≥80% | eval/benchmark_runner.py | ✅ |
| 根因定位准确率提升10% | memory/context_learner.py (持续演化) | ✅ |

## License

Research Project — Huawei 2012 Lab
