"""
update web
AgenticSRE Web Dashboard
FastAPI-based single-page application with SSE streaming.
"""

import asyncio
import json
import logging
import os
import sys
import time
import threading
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ── Setup Paths ──
APP_DIR = Path(__file__).parent
ROOT_DIR = APP_DIR.parent
sys.path.insert(0, str(ROOT_DIR))

from configs.config_loader import get_config
from tools import build_tool_registry, LLMClient
from agents import DetectionAgent, AlertAgent
from orchestrator.pipeline import Pipeline
from orchestrator.daemon import Daemon

logger = logging.getLogger(__name__)

# ── FastAPI App ──
app = FastAPI(title="AgenticSRE Dashboard", version="1.0.0")
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))

# ── Shared State ──
_state = {
    "config": None,
    "pipeline": None,
    "daemon": None,
    "daemon_thread": None,
    "detection_signals": deque(maxlen=200),
    "rca_runs": {},  # run_id → dict
    "pipeline_logs": deque(maxlen=500),
    "daemon_logs": deque(maxlen=500),
    "sse_subscribers": [],
}


def _get_config():
    if _state["config"] is None:
        _state["config"] = get_config()
    return _state["config"]


def _get_pipeline():
    if _state["pipeline"] is None:
        _state["pipeline"] = Pipeline(_get_config())
    return _state["pipeline"]


def _is_offline_mode() -> bool:
    cfg = _get_config()
    return bool(
        getattr(cfg.observability, "backend", "") == "alidata"
        and getattr(cfg.observability, "offline_mode", False)
    )


def _reset_alidata_state():
    """Clear cached AliData adapters so the next request rebuilds them."""
    _alidata_state["downloader"] = None
    _alidata_state["log_tool"] = None
    _alidata_state["trace_tool"] = None
    _alidata_state["metric_tool"] = None


def _refresh_runtime_dependencies():
    """Rebuild runtime objects that depend on mutable observability config."""
    _state["pipeline"] = None
    _reset_alidata_state()

    daemon = _state.get("daemon")
    if daemon:
        try:
            daemon.cfg = _get_config()
            daemon.pipeline = Pipeline(daemon.cfg)
            daemon.poll_interval = daemon.cfg.daemon.poll_interval_seconds
            daemon.dedup_ttl = daemon.cfg.daemon.dedup_ttl_seconds
            daemon.max_concurrent = daemon.cfg.daemon.max_concurrent_pipelines
            daemon.namespace = daemon.cfg.daemon.default_namespace
        except Exception as e:
            logger.warning("Failed to refresh daemon after config change: %s", e)


def _normalize_problem_id(problem_id: str) -> str:
    value = str(problem_id or "").strip()
    if value.startswith("problem_"):
        value = value[len("problem_"):]
    return value


# ── Kubectl Helpers ──

def _kubectl_sync(cmd: str, namespace: str = "") -> str:
    """Execute kubectl command via SSH jump host (synchronous)."""
    import subprocess
    cfg = _get_config()
    ns_flag = f"-n {namespace}" if namespace else ""

    if cfg.kubernetes.use_ssh and cfg.kubernetes.ssh_jump_host:
        ssh_target = cfg.kubernetes.ssh_target or cfg.kubernetes.target_host
        ssh_cmd = f"ssh -J {cfg.kubernetes.ssh_jump_host} {ssh_target} 'kubectl {cmd} {ns_flag}'"
    else:
        ssh_cmd = f"kubectl {cmd} {ns_flag}"

    try:
        result = subprocess.run(
            ssh_cmd, shell=True, capture_output=True, text=True, timeout=30
        )
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return "Error: command timed out"
    except Exception as e:
        return f"Error: {e}"


async def _kubectl(cmd: str, namespace: str = "") -> str:
    """Execute kubectl command without blocking the event loop."""
    return await asyncio.to_thread(_kubectl_sync, cmd, namespace)


async def _kubectl_json(cmd: str, namespace: str = "") -> Any:
    """Execute kubectl -o json and parse without blocking."""
    raw = await _kubectl(f"{cmd} -o json", namespace)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"error": raw}


# ─────────────────────────────────────────
# Page Routes
# ─────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


# ─────────────────────────────────────────
# Cluster Info APIs
# ─────────────────────────────────────────

@app.get("/api/cluster/overview")
async def cluster_overview():
    """Cluster health summary."""
    nodes_raw, pods_raw = await asyncio.gather(
        _kubectl_json("get nodes"),
        _kubectl_json("get pods --all-namespaces"),
    )
    
    nodes = nodes_raw.get("items", [])
    pods = pods_raw.get("items", [])
    
    # Count pod phases
    phases = {}
    total_restarts = 0
    for pod in pods:
        phase = pod.get("status", {}).get("phase", "Unknown")
        phases[phase] = phases.get(phase, 0) + 1
        for cs in pod.get("status", {}).get("containerStatuses", []):
            total_restarts += cs.get("restartCount", 0)
    
    return {
        "nodes": len(nodes),
        "pods_total": len(pods),
        "pod_phases": phases,
        "total_restarts": total_restarts,
        "namespaces": len(set(p.get("metadata", {}).get("namespace", "") for p in pods)),
    }


@app.get("/api/cluster/nodes")
async def cluster_nodes():
    """Detailed node info."""
    data = await _kubectl_json("get nodes")
    nodes = []
    for n in data.get("items", []):
        meta = n.get("metadata", {})
        status = n.get("status", {})
        conditions = {c["type"]: c["status"] for c in status.get("conditions", [])}
        nodes.append({
            "name": meta.get("name", ""),
            "roles": [l.split("/")[-1] for l in meta.get("labels", {}) if "node-role" in l],
            "ready": conditions.get("Ready", "Unknown"),
            "version": status.get("nodeInfo", {}).get("kubeletVersion", ""),
            "os": status.get("nodeInfo", {}).get("osImage", ""),
            "cpu": status.get("capacity", {}).get("cpu", ""),
            "memory": status.get("capacity", {}).get("memory", ""),
        })
    return {"nodes": nodes}


@app.get("/api/cluster/namespaces")
async def cluster_namespaces():
    raw = await _kubectl("get namespaces -o jsonpath='{.items[*].metadata.name}'")
    return {"namespaces": raw.replace("'", "").split()}


@app.get("/api/cluster/pods")
async def cluster_pods(namespace: str = ""):
    """List pods with status info."""
    if namespace:
        data = await _kubectl_json("get pods", namespace)
    else:
        data = await _kubectl_json("get pods --all-namespaces")
    pods = []
    for p in data.get("items", []):
        meta = p.get("metadata", {})
        status = p.get("status", {})
        containers = status.get("containerStatuses", [])
        ready = sum(1 for c in containers if c.get("ready"))
        restarts = sum(c.get("restartCount", 0) for c in containers)
        pods.append({
            "name": meta.get("name", ""),
            "namespace": meta.get("namespace", ""),
            "phase": status.get("phase", "Unknown"),
            "ready": f"{ready}/{len(containers)}",
            "restarts": restarts,
            "node": p.get("spec", {}).get("nodeName", ""),
            "age": meta.get("creationTimestamp", ""),
        })
    return {"pods": pods}


@app.get("/api/cluster/events")
async def cluster_events(namespace: str = "", limit: int = 50):
    """Recent K8s events."""
    if namespace:
        data = await _kubectl_json("get events --sort-by=.lastTimestamp", namespace)
    else:
        data = await _kubectl_json("get events --sort-by=.lastTimestamp --all-namespaces")
    events = []
    for e in data.get("items", [])[-limit:]:
        events.append({
            "type": e.get("type", ""),
            "reason": e.get("reason", ""),
            "message": e.get("message", ""),
            "source": e.get("source", {}).get("component", ""),
            "object": e.get("involvedObject", {}).get("name", ""),
            "namespace": e.get("involvedObject", {}).get("namespace", ""),
            "count": e.get("count", 1),
            "last_seen": e.get("lastTimestamp", ""),
        })
    return {"events": events}


@app.get("/api/cluster/services")
async def cluster_services(namespace: str = ""):
    if namespace:
        data = await _kubectl_json("get services", namespace)
    else:
        data = await _kubectl_json("get services --all-namespaces")
    services = []
    for s in data.get("items", []):
        meta = s.get("metadata", {})
        spec = s.get("spec", {})
        ports = [f"{p.get('port')}/{p.get('protocol','TCP')}" for p in spec.get("ports", [])]
        services.append({
            "name": meta.get("name", ""),
            "namespace": meta.get("namespace", ""),
            "type": spec.get("type", ""),
            "cluster_ip": spec.get("clusterIP", ""),
            "ports": ", ".join(ports),
        })
    return {"services": services}


@app.get("/api/logs/{namespace}/{pod}")
async def pod_logs(namespace: str, pod: str, lines: int = 200, container: str = ""):
    c_flag = f"-c {container}" if container else ""
    raw = await _kubectl(f"logs {pod} {c_flag} --tail={lines}", namespace)
    return {"logs": raw}


# ─────────────────────────────────────────
# Prometheus Query APIs
# ─────────────────────────────────────────

def _prom_query_sync(query: str, query_type: str = "instant",
                     start: str = "", end: str = "", step: str = "60s") -> dict:
    """Execute Prometheus query synchronously."""
    cfg = _get_config()
    base_url = cfg.observability.prometheus_url
    if not base_url:
        return {"error": "Prometheus URL not configured"}

    import requests as req
    try:
        if query_type == "range":
            url = f"{base_url}/api/v1/query_range"
            params = {"query": query, "step": step}
            params["start"] = start or str(int(time.time()) - 3600)
            params["end"] = end or str(int(time.time()))
        else:
            url = f"{base_url}/api/v1/query"
            params = {"query": query}

        resp = req.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") == "success":
            return {"results": data.get("data", {}).get("result", []),
                    "resultType": data.get("data", {}).get("resultType", "")}
        return {"error": data.get("error", "Unknown error")}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/prometheus/query")
async def prometheus_query(query: str = "", query_type: str = "instant",
                           start: str = "", end: str = "", step: str = "60s"):
    """Execute arbitrary PromQL queries."""
    if not query:
        raise HTTPException(400, "Missing 'query' parameter")
    result = await asyncio.to_thread(_prom_query_sync, query, query_type, start, end, step)
    return result


@app.get("/api/prometheus/metrics_summary")
async def prometheus_metrics_summary(namespace: str = ""):
    """Pre-built metrics summary for the dashboard: node CPU/mem/disk + container top."""
    ns_filter = f'namespace="{namespace}"' if namespace else ''

    queries = {
        "node_cpu": 'avg by(instance)(1 - rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100',
        "node_memory": '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100',
        "node_disk": '(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100',
    }

    if ns_filter:
        queries["container_cpu_top"] = (
            f'topk(10, sum by(pod)(rate(container_cpu_usage_seconds_total{{{ns_filter}}}[5m])) * 100)'
        )
        queries["container_mem_top"] = (
            f'topk(10, sum by(pod)(container_memory_working_set_bytes{{{ns_filter}}}) / 1024 / 1024)'
        )
    else:
        queries["container_cpu_top"] = (
            'topk(10, sum by(pod, namespace)(rate(container_cpu_usage_seconds_total[5m])) * 100)'
        )
        queries["container_mem_top"] = (
            'topk(10, sum by(pod, namespace)(container_memory_working_set_bytes) / 1024 / 1024)'
        )

    import concurrent.futures
    results = {}

    def _query_one(key, q):
        return key, _prom_query_sync(q)

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(_query_one, k, q) for k, q in queries.items()]
        for f in concurrent.futures.as_completed(futures):
            k, v = f.result()
            results[k] = v

    return results


# ─────────────────────────────────────────
# Jaeger Trace APIs
# ─────────────────────────────────────────

def _jaeger_request(path: str, params: dict = None) -> dict:
    """Execute Jaeger API request synchronously."""
    cfg = _get_config()
    base_url = cfg.observability.jaeger_url
    if not base_url:
        return {"error": "Jaeger URL not configured"}

    import requests as req
    try:
        url = f"{base_url.rstrip('/')}{path}"
        resp = req.get(url, params=params or {}, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/jaeger/services")
async def jaeger_services():
    """List available services in Jaeger."""
    data = await asyncio.to_thread(_jaeger_request, "/api/services")
    services = data.get("data", []) if not data.get("error") else []
    return {"services": services, "error": data.get("error")}


@app.get("/api/jaeger/traces")
async def jaeger_traces(service: str = "", operation: str = "",
                        min_duration: str = "", max_duration: str = "",
                        limit: int = 20, lookback: str = "1h"):
    """Search traces by service and filters."""
    if not service:
        raise HTTPException(400, "Missing 'service' parameter")

    params = {"service": service, "limit": limit, "lookback": lookback}
    if operation:
        params["operation"] = operation
    if min_duration:
        params["minDuration"] = min_duration
    if max_duration:
        params["maxDuration"] = max_duration

    data = await asyncio.to_thread(_jaeger_request, "/api/traces", params)
    if data.get("error"):
        return {"traces": [], "error": data["error"]}

    traces = data.get("data", [])
    summaries = []
    for trace in traces[:limit]:
        spans = trace.get("spans", [])
        services_in_trace = list(set(
            s.get("process", {}).get("serviceName", "") for s in spans
        ))
        durations = [s.get("duration", 0) for s in spans]
        root_span = next((s for s in spans if not s.get("references")), spans[0] if spans else {})
        summaries.append({
            "traceID": trace.get("traceID", ""),
            "root_service": root_span.get("process", {}).get("serviceName", ""),
            "root_operation": root_span.get("operationName", ""),
            "span_count": len(spans),
            "services": services_in_trace,
            "total_duration_us": max(durations) if durations else 0,
            "avg_duration_us": sum(durations) // max(len(durations), 1),
            "start_time": root_span.get("startTime", 0),
        })

    return {"traces": summaries, "total": len(summaries)}


@app.get("/api/jaeger/trace/{trace_id}")
async def jaeger_trace_detail(trace_id: str):
    """Get full trace detail by trace ID."""
    data = await asyncio.to_thread(_jaeger_request, f"/api/traces/{trace_id}")
    if data.get("error"):
        return {"error": data["error"]}

    traces = data.get("data", [])
    if not traces:
        raise HTTPException(404, "Trace not found")

    trace = traces[0]
    spans = trace.get("spans", [])
    processes = trace.get("processes", {})

    span_list = []
    for s in spans:
        pid = s.get("processID", "")
        proc = processes.get(pid, {})
        span_list.append({
            "spanID": s.get("spanID", ""),
            "operationName": s.get("operationName", ""),
            "serviceName": proc.get("serviceName", ""),
            "duration_us": s.get("duration", 0),
            "startTime": s.get("startTime", 0),
            "tags": {t["key"]: t["value"] for t in s.get("tags", [])},
            "logs": [{"ts": l.get("timestamp"), "fields": l.get("fields")} for l in s.get("logs", [])],
            "references": s.get("references", []),
        })

    return {
        "traceID": trace.get("traceID"),
        "spans": span_list,
        "span_count": len(span_list),
        "processes": processes,
    }


@app.get("/api/jaeger/operations")
async def jaeger_operations(service: str = ""):
    """List operations for a Jaeger service."""
    if not service:
        return {"operations": []}
    data = await asyncio.to_thread(_jaeger_request, f"/api/services/{service}/operations")
    operations = data.get("data", []) if not data.get("error") else []
    return {"operations": operations, "error": data.get("error")}


# ─────────────────────────────────────────
# Detection & Alert APIs
# ─────────────────────────────────────────

@app.get("/api/detection/signals")
async def get_detection_signals():
    return {"signals": list(_state["detection_signals"])}


@app.delete("/api/detection/signals")
async def clear_detection_signals():
    _state["detection_signals"].clear()
    return {"status": "cleared"}


@app.get("/api/detection/stream")
async def detection_stream():
    """SSE stream for detection signals."""
    async def event_gen():
        last_count = 0
        while True:
            current = len(_state["detection_signals"])
            if current > last_count:
                new = list(_state["detection_signals"])[last_count:]
                for s in new:
                    yield f"data: {json.dumps(s)}\n\n"
                last_count = current
            else:
                yield f": heartbeat {int(time.time())}\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@app.get("/api/detection/config")
async def get_detection_config():
    """返回当前检测配置"""
    cfg = _get_config()
    det = cfg.detection
    return {
        "sources_enabled": det.sources_enabled,
        "metric_checks": det.metric_checks,
        "critical_event_reasons": det.critical_event_reasons,
        "critical_pod_reasons": det.critical_pod_reasons,
        "default_detect_methods": det.default_detect_methods,
        "default_lookback_m": det.default_lookback_m,
        "default_z_threshold": det.default_z_threshold,
        "default_ewma_span": det.default_ewma_span,
        "categories_enabled": det.categories_enabled,
        "business_services": det.business_services,
        "db_services": det.db_services,
        "thresholds": det.thresholds,
    }


@app.put("/api/detection/config")
async def update_detection_config(request: Request):
    """运行时更新检测配置（内存生效，不写 YAML）"""
    body = await request.json()
    cfg = _get_config()
    det = cfg.detection
    if "sources_enabled" in body:
        det.sources_enabled.update(body["sources_enabled"])
    if "metric_checks" in body:
        det.metric_checks = body["metric_checks"]
    if "critical_event_reasons" in body:
        det.critical_event_reasons = body["critical_event_reasons"]
    if "critical_pod_reasons" in body:
        det.critical_pod_reasons = body["critical_pod_reasons"]
    if "default_detect_methods" in body:
        det.default_detect_methods = body["default_detect_methods"]
    if "default_lookback_m" in body:
        det.default_lookback_m = int(body["default_lookback_m"])
    if "default_z_threshold" in body:
        det.default_z_threshold = float(body["default_z_threshold"])
    if "default_ewma_span" in body:
        det.default_ewma_span = int(body["default_ewma_span"])
    if "categories_enabled" in body and isinstance(body["categories_enabled"], dict):
        det.categories_enabled.update(body["categories_enabled"])
    if "business_services" in body and isinstance(body["business_services"], list):
        det.business_services = body["business_services"]
    if "db_services" in body and isinstance(body["db_services"], list):
        det.db_services = body["db_services"]
    if "thresholds" in body and isinstance(body["thresholds"], dict):
        det.thresholds.update(body["thresholds"])
    # 重建 pipeline 使配置生效
    _state["pipeline"] = None
    return {
        "status": "ok",
        "detection": {
            "sources_enabled": det.sources_enabled,
            "metric_checks": det.metric_checks,
            "critical_event_reasons": det.critical_event_reasons,
            "critical_pod_reasons": det.critical_pod_reasons,
            "default_detect_methods": det.default_detect_methods,
            "default_lookback_m": det.default_lookback_m,
            "default_z_threshold": det.default_z_threshold,
            "default_ewma_span": det.default_ewma_span,
            "categories_enabled": det.categories_enabled,
            "business_services": det.business_services,
            "db_services": det.db_services,
            "thresholds": det.thresholds,
        },
    }


@app.get("/api/alerts/list")
async def alert_list(namespace: str = ""):
    """Fetch all current alerts from all sources with details."""
    cfg = _get_config()
    registry = build_tool_registry(cfg)
    llm = LLMClient(cfg.llm) if cfg.llm.api_key else None
    agent = DetectionAgent(llm, registry, cfg)
    signals = await asyncio.to_thread(agent.detect, namespace)
    return {
        "alerts": [s.to_dict() for s in signals],
        "total": len(signals),
        "sources": list(set(s.source for s in signals)),
    }


@app.get("/api/alerts/scan")
async def alert_scan(namespace: str = ""):
    """Run alert compression scan (SOW core)."""
    cfg = _get_config()
    if not cfg.llm.api_key:
        raise HTTPException(
            503,
            "LLM API Key 未配置。请在 .env 文件中设置 LLM_API_KEY，然后重启服务。"
        )
    llm = LLMClient(cfg.llm)
    registry = build_tool_registry(cfg)
    agent = AlertAgent(llm, registry)

    # Collect raw alerts first, then compress
    raw_alerts = await agent._collect_alerts(namespace)
    result = await agent.compress_and_recommend(alerts=raw_alerts, namespace=namespace)

    # Attach raw alert details for frontend display
    result["raw_alerts"] = [
        {"name": a.name, "severity": a.severity, "source": a.source,
         "timestamp": a.timestamp, "labels": a.labels, "message": a.message}
        for a in raw_alerts
    ]
    return result


# ─────────────────────────────────────────
# RCA APIs
# ─────────────────────────────────────────

@app.post("/api/rca/run")
async def rca_run(request: Request):
    """Trigger an RCA pipeline."""
    body = await request.json()
    query = body.get("query", "")
    namespace = body.get("namespace", "")

    if not query:
        raise HTTPException(400, "Missing 'query' field")

    cfg = _get_config()
    if not cfg.llm.api_key:
        raise HTTPException(
            503,
            "LLM API Key 未配置。请在 .env 文件中设置 LLM_API_KEY 或在 config_cluster.yaml 中直接配置 llm.api_key，然后重启服务。"
        )

    run_id = f"rca-{uuid.uuid4().hex[:8]}"
    _state["rca_runs"][run_id] = {
        "id": run_id,
        "query": query,
        "namespace": namespace,
        "status": "running",
        "logs": [],
        "events": [],
        "result": None,
        "started_at": time.time(),
    }

    def log_cb(msg):
        if isinstance(msg, dict):
            _state["rca_runs"][run_id]["events"].append(msg)
        else:
            _state["rca_runs"][run_id]["logs"].append(msg)

    def _run_sync():
        """Run pipeline in a thread to avoid blocking the event loop."""
        try:
            pipeline = _get_pipeline()
            result = asyncio.run(pipeline.run(query, namespace, log_cb))
            _state["rca_runs"][run_id]["result"] = result.to_dict()
            _state["rca_runs"][run_id]["status"] = result.status
        except Exception as e:
            logger.error(f"RCA pipeline error: {e}", exc_info=True)
            _state["rca_runs"][run_id]["status"] = "failed"
            _state["rca_runs"][run_id]["result"] = {"error": str(e)}

    # Run in background thread (pipeline does sync LLM calls that block the loop)
    import threading
    t = threading.Thread(target=_run_sync, daemon=True, name=f"rca-{run_id}")
    t.start()
    return {"run_id": run_id}


@app.get("/api/rca/history")
async def rca_history(limit: int = 20):
    runs = sorted(_state["rca_runs"].values(), key=lambda r: r.get("started_at", 0), reverse=True)
    return {"runs": [
        {
            "id": r["id"],
            "query": r["query"],
            "status": r["status"],
            "started_at": r.get("started_at"),
            "duration_s": (r.get("result", {}) or {}).get("duration_s", 0),
        }
        for r in runs[:limit]
    ]}


@app.get("/api/rca/{run_id}")
async def rca_status(run_id: str):
    run = _state["rca_runs"].get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return run


@app.get("/api/rca/{run_id}/stream")
async def rca_stream(run_id: str):
    """SSE stream for RCA execution logs."""
    run = _state["rca_runs"].get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    async def event_gen():
        log_idx = 0
        evt_idx = 0
        while True:
            # Send new logs
            logs = run["logs"]
            if log_idx < len(logs):
                for msg in logs[log_idx:]:
                    yield f"data: {json.dumps({'type': 'log', 'msg': msg})}\n\n"
                log_idx = len(logs)

            # Send new structured events
            events = run.get("events", [])
            if evt_idx < len(events):
                for evt in events[evt_idx:]:
                    yield f"data: {json.dumps({'type': 'event', 'data': evt})}\n\n"
                evt_idx = len(events)

            if run["status"] in ("completed", "failed"):
                yield f"data: {json.dumps({'type': 'done', 'status': run['status'], 'result': run.get('result')})}\n\n"
                break

            yield f": heartbeat\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


# ─────────────────────────────────────────
# Remediation APIs
# ─────────────────────────────────────────

@app.post("/api/rca/{run_id}/remediation/approve")
async def rca_remediation_approve(run_id: str):
    """Approve and execute the pending remediation plan."""
    run = _state["rca_runs"].get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    result = run.get("result")
    if not result:
        raise HTTPException(400, "RCA not completed yet")

    # Find remediation data — could be nested in pipeline result
    rca_inner = result.get("result", result)
    rem_data = None
    if isinstance(rca_inner, dict):
        # Check evidence.remediation in the inner RCA result
        evidence = rca_inner.get("evidence", {})
        if isinstance(evidence, dict):
            rem_data = evidence.get("remediation")
    # Also check events for remediation plan
    if not rem_data:
        for evt in reversed(run.get("events", [])):
            if evt.get("event") == "remediation":
                rem_data = evt.get("data")
                break

    if not rem_data or rem_data.get("status") != "pending_approval":
        raise HTTPException(400, "No pending remediation plan found")

    plan = rem_data.get("plan", {})
    if not plan.get("actions"):
        raise HTTPException(400, "Remediation plan has no actions")

    # Execute the plan
    cfg = _get_config()
    from tools import build_tool_registry, LLMClient
    from agents import RemediationAgent
    registry = build_tool_registry(cfg, allow_write=True)
    llm = LLMClient(cfg.llm)
    agent = RemediationAgent(llm, registry, cfg)

    # Override to skip approval check this time
    original_require = agent.require_approval
    agent.require_approval = False
    agent.enabled = True

    rca_result = rca_inner if isinstance(rca_inner, dict) else result
    exec_result = await agent.remediate(rca_result, confidence=1.0, approved=True)

    agent.require_approval = original_require

    # Store the execution result
    run["remediation_result"] = exec_result
    run.setdefault("events", []).append({"event": "remediation_executed", "data": exec_result})

    return exec_result


@app.post("/api/rca/{run_id}/remediation/rollback")
async def rca_remediation_rollback(run_id: str):
    """Roll back the last remediation execution."""
    run = _state["rca_runs"].get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    cfg = _get_config()
    from tools import build_tool_registry, LLMClient
    from agents import RemediationAgent
    registry = build_tool_registry(cfg, allow_write=True)
    llm = LLMClient(cfg.llm)
    agent = RemediationAgent(llm, registry, cfg)

    rollback_result = agent.rollback()
    run["remediation_rollback"] = rollback_result
    run.setdefault("events", []).append({"event": "remediation_rollback", "data": rollback_result})

    return rollback_result


@app.get("/api/rca/{run_id}/remediation")
async def rca_remediation_status(run_id: str):
    """Get remediation status for a run."""
    run = _state["rca_runs"].get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    # Find remediation event
    rem_data = None
    for evt in reversed(run.get("events", [])):
        if evt.get("event") in ("remediation", "remediation_executed", "remediation_rollback"):
            rem_data = evt.get("data")
            break

    return {
        "run_id": run_id,
        "remediation": rem_data,
        "execution": run.get("remediation_result"),
        "rollback": run.get("remediation_rollback"),
    }


# ─────────────────────────────────────────
# Pipeline APIs
# ─────────────────────────────────────────

@app.get("/api/pipeline/history")
async def pipeline_history():
    pipeline = _get_pipeline()
    return {"history": pipeline.get_history()}


@app.get("/api/pipeline/stats")
async def pipeline_stats():
    pipeline = _get_pipeline()
    return pipeline.get_stats()


# ─────────────────────────────────────────
# Daemon Management APIs
# ─────────────────────────────────────────

@app.get("/api/daemon/status")
async def daemon_status():
    daemon = _state.get("daemon")
    if daemon and daemon._running:
        return daemon.status()
    return {"running": False}


@app.post("/api/daemon/start")
async def daemon_start(request: Request):
    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    
    if _state.get("daemon") and _state["daemon"]._running:
        return {"status": "already_running"}

    cfg = _get_config()

    def _push_signal(signal_obj):
        """Push detection signal to SSE deque for real-time streaming."""
        _state["detection_signals"].append(
            signal_obj.to_dict() if hasattr(signal_obj, "to_dict") else signal_obj
        )

    daemon = Daemon(
        cfg,
        log_callback=lambda msg: _state["daemon_logs"].append(msg),
        signal_callback=_push_signal,
    )
    _state["daemon"] = daemon

    def run():
        asyncio.run(daemon.start())

    t = threading.Thread(target=run, daemon=True, name="sre-daemon")
    t.start()
    _state["daemon_thread"] = t
    return {"status": "started"}


@app.post("/api/daemon/stop")
async def daemon_stop():
    daemon = _state.get("daemon")
    if daemon and daemon._running:
        asyncio.run_coroutine_threadsafe(daemon.stop(), daemon._loop)
        return {"status": "stopping"}
    return {"status": "not_running"}


@app.get("/api/daemon/logs")
async def daemon_logs(limit: int = 100):
    logs = list(_state["daemon_logs"])[-limit:]
    return {"logs": logs}


@app.get("/api/daemon/logs/stream")
async def daemon_log_stream():
    """SSE stream for daemon logs."""
    async def event_gen():
        idx = 0
        while True:
            logs = list(_state["daemon_logs"])
            if idx < len(logs):
                for msg in logs[idx:]:
                    yield f"data: {json.dumps({'type': 'log', 'msg': msg})}\n\n"
                idx = len(logs)
            
            # Status heartbeat
            daemon = _state.get("daemon")
            if daemon and daemon._running:
                yield f"data: {json.dumps({'type': 'status', 'data': daemon.status()})}\n\n"
            
            yield f": heartbeat\n\n"
            await asyncio.sleep(3)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


# ─────────────────────────────────────────
# AliData APIs (Alibaba Cloud Logs & Traces)
# ─────────────────────────────────────────

_alidata_state = {
    "downloader": None,
    "log_tool": None,
    "trace_tool": None,
    "metric_tool": None,
}


def _get_alidata_tools():
    """Lazy-init AliData tools."""
    if _alidata_state["log_tool"] is None:
        from tools.alidata_observability import (
            AliDataLogTool, AliDataTraceTool, AliDataMetricTool,
            create_ali_downloader,
        )
        cfg = _get_config()
        env_file = getattr(cfg.observability, "alidata_env_file", ".env")
        downloader = create_ali_downloader(
            env_file,
            offline_mode=getattr(cfg.observability, "offline_mode", False),
            offline_data_dir=getattr(cfg.observability, "offline_data_dir", ""),
            offline_problem_id=getattr(cfg.observability, "offline_problem_id", ""),
            offline_data_type=getattr(cfg.observability, "offline_data_type", "auto"),
        )
        _alidata_state["downloader"] = downloader
        _alidata_state["log_tool"] = AliDataLogTool(downloader)
        _alidata_state["trace_tool"] = AliDataTraceTool(downloader)
        _alidata_state["metric_tool"] = AliDataMetricTool(downloader)
    return _alidata_state["log_tool"], _alidata_state["trace_tool"]


@app.get("/api/alidata/status")
async def alidata_status():
    """Check AliData connectivity."""
    try:
        log_tool, trace_tool = _get_alidata_tools()
        log_ok = await asyncio.to_thread(log_tool.health_check)
        trace_ok = await asyncio.to_thread(trace_tool.health_check)
        return {"connected": log_ok or trace_ok, "log_ok": log_ok, "trace_ok": trace_ok}
    except Exception as e:
        return {"connected": False, "error": str(e)}


@app.get("/api/offline/problems")
async def offline_problems():
    """List available offline problem datasets for the UI selector."""
    cfg = _get_config()
    current_problem_id = getattr(cfg.observability, "offline_problem_id", "")
    current_data_type = getattr(cfg.observability, "offline_data_type", "auto")

    if not _is_offline_mode():
        return {
            "enabled": False,
            "current_problem_id": current_problem_id,
            "offline_data_type": current_data_type,
            "problems": [],
        }

    data_dir = getattr(cfg.observability, "offline_data_dir", "")
    if not data_dir:
        return {
            "enabled": True,
            "current_problem_id": current_problem_id,
            "offline_data_type": current_data_type,
            "problems": [],
            "error": "offline_data_dir is not configured",
        }

    try:
        from tools.alidata_sdk.utils.local_data_loader import get_local_data_loader

        loader = get_local_data_loader(data_dir=data_dir)
        problem_ids = loader.get_available_problems()
        problems = []

        for problem_id in problem_ids:
            summary = loader.get_data_summary(problem_id)
            availability = summary.get("data_availability", {})
            metadata = summary.get("metadata") or {}
            problems.append({
                "problem_id": problem_id,
                "label": f"problem_{problem_id}",
                "selected": problem_id == current_problem_id,
                "has_failure": all(
                    availability.get(name, False)
                    for name in ("failure_logs", "failure_metrics", "failure_traces")
                ),
                "has_baseline": all(
                    availability.get(name, False)
                    for name in ("baseline_logs", "baseline_metrics")
                ),
                "time_range": metadata.get("time_range", ""),
            })

        return {
            "enabled": True,
            "current_problem_id": current_problem_id,
            "offline_data_type": current_data_type,
            "problems": problems,
        }
    except Exception as e:
        logger.warning("Failed to list offline problems: %s", e)
        return {
            "enabled": True,
            "current_problem_id": current_problem_id,
            "offline_data_type": current_data_type,
            "problems": [],
            "error": str(e),
        }


@app.put("/api/offline/problem")
async def update_offline_problem(request: Request):
    """Switch the active offline problem id at runtime."""
    cfg = _get_config()
    if not _is_offline_mode():
        raise HTTPException(400, "Offline mode is not enabled")

    body = await request.json()
    new_problem_id = _normalize_problem_id(body.get("offline_problem_id", ""))
    if not new_problem_id:
        raise HTTPException(400, "Missing 'offline_problem_id'")

    data_dir = getattr(cfg.observability, "offline_data_dir", "")
    if not data_dir:
        raise HTTPException(400, "offline_data_dir is not configured")

    try:
        from tools.alidata_sdk.utils.local_data_loader import get_local_data_loader

        loader = get_local_data_loader(data_dir=data_dir)
        available_problems = set(loader.get_available_problems())
    except Exception as e:
        raise HTTPException(500, f"Failed to read offline datasets: {e}") from e

    if new_problem_id not in available_problems:
        raise HTTPException(404, f"Offline dataset problem_{new_problem_id} not found")

    new_data_type = str(body.get("offline_data_type") or "").strip().lower()
    if new_data_type and new_data_type not in {"auto", "baseline", "failure"}:
        raise HTTPException(400, "offline_data_type must be one of: auto, baseline, failure")

    cfg.observability.offline_problem_id = new_problem_id
    if new_data_type:
        cfg.observability.offline_data_type = new_data_type

    _refresh_runtime_dependencies()
    logger.info(
        "Switched offline dataset to problem_%s/%s",
        cfg.observability.offline_problem_id,
        getattr(cfg.observability, "offline_data_type", "auto"),
    )

    return {
        "status": "ok",
        "offline_problem_id": cfg.observability.offline_problem_id,
        "offline_data_type": getattr(cfg.observability, "offline_data_type", "auto"),
    }


@app.get("/api/alidata/logs")
async def alidata_logs(query: str = "", time_range: str = "1h",
                       level: str = "", size: int = 200, namespace: str = ""):
    """Fetch logs from Alibaba Cloud SLS/ARMS."""
    try:
        log_tool, _ = _get_alidata_tools()
        result = await asyncio.to_thread(
            log_tool._execute, query=query, time_range=time_range,
            level=level, size=size, namespace=namespace
        )
        if result.success:
            return result.data
        return {"error": result.error, "total_hits": 0, "entries": []}
    except Exception as e:
        return {"error": str(e), "total_hits": 0, "entries": []}


@app.get("/api/alidata/services")
async def alidata_services():
    """List available services from AliData trace data."""
    try:
        _, trace_tool = _get_alidata_tools()
        result = await asyncio.to_thread(trace_tool._execute)
        if result.success:
            services = result.data.get("data", [])
            return {"services": services}
        return {"services": [], "error": result.error}
    except Exception as e:
        return {"services": [], "error": str(e)}


@app.get("/api/alidata/traces")
async def alidata_traces(service: str = "", operation: str = "",
                         min_duration: str = "", max_duration: str = "",
                         limit: int = 20, lookback: str = "1h"):
    """Search traces from Alibaba Cloud ARMS."""
    if not service:
        raise HTTPException(400, "Missing 'service' parameter")
    try:
        _, trace_tool = _get_alidata_tools()
        result = await asyncio.to_thread(
            trace_tool._execute, service=service, operation=operation,
            min_duration=min_duration, max_duration=max_duration,
            limit=limit, lookback=lookback
        )
        if result.success:
            return result.data
        return {"traces": [], "error": result.error}
    except Exception as e:
        return {"traces": [], "error": str(e)}


@app.get("/api/alidata/trace/{trace_id}")
async def alidata_trace_detail(trace_id: str):
    """Get full trace detail by trace ID from AliData."""
    try:
        _, trace_tool = _get_alidata_tools()
        result = await asyncio.to_thread(
            trace_tool._execute, trace_id=trace_id
        )
        if result.success:
            return result.data
        return {"error": result.error}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/alidata/metrics")
async def alidata_metrics(query: str = "", namespace: str = "",
                          start: str = "", end: str = ""):
    """Fetch metrics from Alibaba Cloud ARMS.
    Returns k8s pod metrics (CPU/mem) and APM service metrics (request count, latency).
    """
    try:
        _get_alidata_tools()  # ensure init
        metric_tool = _alidata_state["metric_tool"]
        result = await asyncio.to_thread(
            metric_tool._execute, query=query, namespace=namespace,
            start=start, end=end, max_results=0
        )
        if result.success:
            data = result.data
            # Group by service for frontend display
            k8s_by_service = {}
            apm_by_service = {}
            for r in data.get("results", []):
                metric = r.get("metric", {})
                name = metric.get("__name__", "")
                svc = metric.get("service", "")
                pod = metric.get("pod", "")
                val = r.get("value", [0, "0"])
                values = r.get("values", [])

                if pod:
                    # k8s pod metric
                    k8s_by_service.setdefault(svc, {}).setdefault(pod, {})[name] = {
                        "current": float(val[1]) if len(val) > 1 else 0,
                        "values": values[-60:],
                    }
                else:
                    # APM service metric
                    apm_by_service.setdefault(svc, {})[name] = {
                        "current": float(val[1]) if len(val) > 1 else 0,
                        "values": values[-60:],
                    }

            return {
                "k8s_metrics": k8s_by_service,
                "apm_metrics": apm_by_service,
                "total_results": data.get("result_count", 0),
            }
        return {"error": result.error, "k8s_metrics": {}, "apm_metrics": {}}
    except Exception as e:
        return {"error": str(e), "k8s_metrics": {}, "apm_metrics": {}}


# ─────────────────────────────────────────
# Model Interaction APIs (OpsLLM-7B)
# ─────────────────────────────────────────

_state["chat_sessions"] = {}  # session_id → {"messages": [], "created_at": time}


@app.get("/api/model/info")
async def get_model_info():
    """Get current LLM model configuration."""
    cfg = _get_config()
    return {
        "model": cfg.llm.model,
        "base_url": cfg.llm.base_url,
        "configured": bool(cfg.llm.api_key),
        "max_tokens": cfg.llm.max_tokens,
        "temperature": cfg.llm.temperature,
    }


@app.post("/api/model/chat")
async def model_chat(request: Request):
    """Send a message to the LLM model and get a response."""
    body = await request.json()
    message = body.get("message", "")
    session_id = body.get("session_id", "default")
    stream = body.get("stream", False)

    if not message:
        raise HTTPException(400, "Missing 'message' field")

    cfg = _get_config()
    if not cfg.llm.api_key:
        raise HTTPException(
            503,
            "LLM API Key 未配置。请在 .env 文件中设置 LLM_API_KEY。"
        )

    # Initialize or update session
    if session_id not in _state["chat_sessions"]:
        _state["chat_sessions"][session_id] = {
            "messages": [],
            "created_at": time.time(),
        }

    session = _state["chat_sessions"][session_id]
    session["messages"].append({"role": "user", "content": message})

    system_prompt = {
        "role": "system",
        "content": "你是 AgenticSRE 的智能运维助手，基于 OpsLLM-7B 模型。你专注于 Kubernetes 容器运维、故障诊断、性能分析、告警处理等 SRE 领域知识。请用中文回答问题，提供专业、准确的技术建议。"
    }
    llm_messages = [system_prompt] + session["messages"][-20:]

    try:
        llm = LLMClient(cfg.llm)

        if stream:
            async def generate():
                try:
                    response_text = await asyncio.to_thread(llm.chat, llm_messages)
                    session["messages"].append({"role": "assistant", "content": response_text})
                    chunk_size = 50
                    for i in range(0, len(response_text), chunk_size):
                        chunk = response_text[i:i+chunk_size]
                        yield f"data: {json.dumps({'type': 'chunk', 'content': chunk})}\n\n"
                        await asyncio.sleep(0.01)
                    yield f"data: {json.dumps({'type': 'done', 'session_id': session_id})}\n\n"
                except Exception as e:
                    yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

            return StreamingResponse(generate(), media_type="text/event-stream")
        else:
            response_text = await asyncio.to_thread(llm.chat, llm_messages)
            session["messages"].append({"role": "assistant", "content": response_text})
            return {
                "response": response_text,
                "session_id": session_id,
                "message_count": len(session["messages"]),
            }
    except Exception as e:
        logger.error(f"Model chat error: {e}", exc_info=True)
        raise HTTPException(500, f"模型调用失败: {str(e)}")


@app.get("/api/model/chat/history/{session_id}")
async def get_chat_history(session_id: str):
    """Get chat history for a session."""
    session = _state["chat_sessions"].get(session_id)
    if not session:
        return {"messages": [], "session_id": session_id}
    return {
        "messages": session["messages"],
        "session_id": session_id,
        "created_at": session["created_at"],
    }


@app.delete("/api/model/chat/history/{session_id}")
async def clear_chat_history(session_id: str):
    """Clear chat history for a session."""
    if session_id in _state["chat_sessions"]:
        _state["chat_sessions"][session_id]["messages"] = []
        return {"status": "cleared", "session_id": session_id}
    return {"status": "not_found", "session_id": session_id}


@app.get("/api/model/chat/sessions")
async def list_chat_sessions():
    """List all chat sessions."""
    sessions = []
    for sid, session in _state["chat_sessions"].items():
        sessions.append({
            "session_id": sid,
            "message_count": len(session["messages"]),
            "created_at": session["created_at"],
        })
    return {"sessions": sessions}


# ─────────────────────────────────────────
# Health & Meta
# ─────────────────────────────────────────

@app.get("/api/health")
async def health():
    cfg = _get_config()
    llm_ok = bool(cfg.llm.api_key)
    return {
        "status": "ok",
        "timestamp": time.time(),
        "llm_configured": llm_ok,
        "observability_backend": getattr(cfg.observability, "backend", "native"),
        "offline_mode": _is_offline_mode(),
        "offline_problem_id": getattr(cfg.observability, "offline_problem_id", ""),
        "offline_data_type": getattr(cfg.observability, "offline_data_type", ""),
    }


@app.get("/api/config")
async def get_config_info():
    cfg = _get_config()
    return {
        "observability": {
            "backend": getattr(cfg.observability, "backend", "native"),
            "offline_mode": _is_offline_mode(),
            "offline_problem_id": getattr(cfg.observability, "offline_problem_id", ""),
            "offline_data_type": getattr(cfg.observability, "offline_data_type", ""),
        },
        "llm_model": cfg.llm.model,
        "pipeline": {
            "max_iterations": cfg.pipeline.max_evidence_iterations,
            "confidence_threshold": cfg.pipeline.hypothesis_confidence_threshold,
            "enable_correlation": cfg.pipeline.enable_correlation,
            "enable_graph_rca": cfg.pipeline.enable_graph_rca,
            "enable_recovery": cfg.pipeline.enable_recovery,
        },
        "daemon": {
            "poll_interval": cfg.daemon.poll_interval_seconds,
            "dedup_ttl": cfg.daemon.dedup_ttl_seconds,
            "max_concurrent": cfg.daemon.max_concurrent_pipelines,
        },
    }


# ─────────────────────────────────────────
# Startup
# ─────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    logger.info("AgenticSRE Dashboard starting...")
    cfg = _get_config()
    if not cfg.llm.api_key:
        logger.warning(
            "⚠️  LLM API Key 未配置！RCA、告警压缩等 LLM 功能将不可用。"
            "请在项目根目录 .env 文件中设置 LLM_API_KEY=<your-key>，"
            "或在 configs/config_cluster.yaml 中配置 llm.api_key，然后重启服务。"
        )
    else:
        logger.info(f"LLM configured: model={cfg.llm.model}, base_url={cfg.llm.base_url}")


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=8080)
