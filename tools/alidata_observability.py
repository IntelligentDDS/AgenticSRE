"""
AgenticSRE AliData Observability Adapters
Adapts Alibaba Cloud ARMS/SLS observability APIs (via DataDownloader) to the
standard PrometheusTool / ElasticsearchTool / JaegerTool interfaces so that
all Agents can consume AliData transparently.
"""

import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from tools.base_tool import SRETool, ToolResult

logger = logging.getLogger(__name__)


# ───────────── DataDownloader Factory ─────────────

def create_ali_downloader(
    env_file: str = "",
    offline_mode: bool = False,
    offline_data_dir: str = "",
    offline_problem_id: str = "",
    offline_data_type: str = "auto",
):
    """
    Create an AliData DataDownloader instance.
    Loads credentials from the specified .env file (or default .env).
    """
    if env_file and not offline_mode:
        try:
            from dotenv import load_dotenv
            load_dotenv(env_file, override=True)
        except ImportError:
            # Manual .env loading
            from pathlib import Path
            p = Path(env_file)
            if p.exists():
                for line in p.read_text().splitlines():
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, _, v = line.partition('=')
                        k, v = k.strip(), v.strip().strip('"').strip("'")
                        if k and k not in os.environ:
                            os.environ[k] = v

    from tools.alidata_sdk.download_data import DataDownloader
    return DataDownloader(
        offline_mode=offline_mode,
        data_dir=offline_data_dir,
        problem_id=offline_problem_id,
        data_type=offline_data_type,
    )


def _run_async(coro):
    """Run an async coroutine from sync context, reusing existing loop if any."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # We're inside an async context — use a new thread
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    else:
        return asyncio.run(coro)


def _parse_time_range(lookback: str = "1h") -> tuple:
    """Parse a lookback string (e.g. '1h', '30m') into (start, end) datetimes."""
    end = datetime.now()
    num = int(''.join(c for c in lookback if c.isdigit()) or '1')
    if 'h' in lookback:
        start = end - timedelta(hours=num)
    elif 'm' in lookback:
        start = end - timedelta(minutes=num)
    elif 'd' in lookback:
        start = end - timedelta(days=num)
    else:
        start = end - timedelta(hours=1)
    return start, end


# ═══════════════════════════════════════════
#  AliData Metric Tool (replaces Prometheus)
# ═══════════════════════════════════════════

class AliDataMetricTool(SRETool):
    """
    Fetches metrics from Alibaba Cloud ARMS via DataDownloader,
    converts to Prometheus-compatible format for MetricAgent consumption.
    """

    name = "prometheus"
    description = "Fetch metrics from AliData (ARMS) — Prometheus-compatible adapter"

    def __init__(self, downloader, llm_client=None):
        self.downloader = downloader
        self.llm = llm_client

    def _execute(self, query: str = "", query_type: str = "instant",
                 start: str = "", end: str = "", step: str = "60s",
                 natural_language: str = "", namespace: str = "",
                 max_results: Optional[int] = 50) -> ToolResult:
        """
        Fetch metrics from AliData and return in Prometheus format.

        The `query` param is used as a metric name filter (e.g. 'pod_cpu_usage_rate',
        'container_memory', or partial match). For ALERTS queries, returns empty
        (AliData does not have Prometheus alert rules).
        """
        effective_query = query or natural_language or ""

        # Prometheus ALERTS query — not applicable for AliData
        if "ALERTS" in effective_query:
            return ToolResult(success=True, data={
                "query": effective_query, "result_count": 0, "results": [],
            })

        try:
            # Determine time range
            if start and end:
                try:
                    s = datetime.fromtimestamp(float(start))
                    e = datetime.fromtimestamp(float(end))
                except (ValueError, OSError):
                    s, e = _parse_time_range("1h")
            else:
                s, e = _parse_time_range("1h")

            # Fetch data from AliData API
            data = _run_async(self.downloader._download_metric_data(s, e))
            if not data:
                return ToolResult(success=True, data={
                    "query": effective_query, "result_count": 0, "results": [],
                })

            results = []
            apm_only = self._is_apm_only_query(effective_query)

            # Convert k8s_metrics: {service: {pod: {metric: {values, timestamps}}}}
            # Skip k8s_metrics when the query targets APM-only metrics
            if not apm_only:
                k8s = data.get("k8s_metrics", {})
                for svc_name, pods in k8s.items():
                    if not isinstance(pods, dict):
                        continue
                    for pod_name, metrics in pods.items():
                        if not isinstance(metrics, dict):
                            continue
                        for metric_name, series in metrics.items():
                            if metric_name == "entity_id":
                                continue
                            if not isinstance(series, dict) or "values" not in series:
                                continue

                            # Filter by query (metric name match)
                            if effective_query and not self._metric_matches(
                                effective_query, metric_name, svc_name, pod_name
                            ):
                                continue

                            # Convert to Prometheus format: [[ts_seconds, "value"], ...]
                            values = self._to_prom_values(
                                series["values"], series.get("timestamps", [])
                            )
                            results.append({
                                "metric": {
                                    "pod": pod_name,
                                    "service": svc_name,
                                    "namespace": namespace,
                                    "__name__": metric_name,
                                },
                                "values": values,
                                "value": values[-1] if values else [0, "0"],
                            })

            # Convert apm_metrics: {service: {metric: {values, timestamps}}}
            apm = data.get("apm_metrics", {})
            for svc_name, metrics in apm.items():
                if not isinstance(metrics, dict):
                    continue
                for metric_name, series in metrics.items():
                    if not isinstance(series, dict) or "values" not in series:
                        continue

                    if effective_query and not self._metric_matches(
                        effective_query, metric_name, svc_name
                    ):
                        continue

                    values = self._to_prom_values(
                        series["values"], series.get("timestamps", [])
                    )
                    results.append({
                        "metric": {
                            "service": svc_name,
                            "namespace": namespace,
                            "__name__": metric_name,
                        },
                        "values": values,
                        "value": values[-1] if values else [0, "0"],
                    })

            limited_results = results
            if max_results is not None and max_results > 0:
                limited_results = results[:max_results]

            return ToolResult(success=True, data={
                "query": effective_query,
                "result_count": len(results),
                "results": limited_results,
            })

        except Exception as e:
            logger.error(f"AliDataMetricTool error: {e}")
            return ToolResult(success=False, error=str(e))

    # PromQL query → AliData metric name mapping
    # MetricAgent sends PromQL; we map to AliData metric names
    PROMQL_TO_ALIDATA = {
        # infrastructure (node-level) — no AliData equivalent, skip
        # application (container/pod-level)
        "container_cpu_usage_seconds_total":     ["pod_cpu_usage_rate"],
        "container_memory_working_set_bytes":    ["pod_memory_working_set_bytes"],
        "container_spec_memory_limit_bytes":     ["pod_memory_usage_vs_limit"],
        "kube_pod_container_resource_limits":     ["pod_cpu_usage_rate_vs_limit", "pod_memory_usage_vs_limit"],
        "container_memory":                       ["pod_memory_usage_bytes", "pod_memory_working_set_bytes",
                                                   "pod_memory_usage_vs_limit", "pod_memory_usage_vs_request"],
        "container_cpu":                          ["pod_cpu_usage_rate", "pod_cpu_usage_rate_vs_limit",
                                                   "pod_cpu_usage_rate_vs_request"],
        # workload (business-level) — from APM metrics
        "http_requests_total":                    ["request_count", "error_count"],
        "http_request_duration_seconds":          ["avg_request_latency_seconds"],
    }

    # PromQL patterns that should ONLY match APM metrics, not k8s pod metrics
    PROMQL_APM_ONLY = {
        "http_requests_total", "http_request_duration_seconds",
    }

    @staticmethod
    def _metric_matches(query: str, metric_name: str, *labels: str) -> bool:
        """Check if a query string matches the metric name or labels."""
        q = query.lower()
        # Direct metric name match
        if metric_name.lower().find(q) >= 0:
            return True
        # Label match (service, pod name)
        for label in labels:
            if label.lower().find(q) >= 0:
                return True
        # PromQL → AliData mapping: check if the PromQL contains a known
        # Prometheus metric name that maps to this AliData metric
        for prom_name, ali_names in AliDataMetricTool.PROMQL_TO_ALIDATA.items():
            if prom_name in q and metric_name in ali_names:
                return True
        # Keyword-level fallback
        keywords = {
            "cpu": "cpu", "memory": "memory", "mem": "memory",
            "disk": "disk", "network": "network", "restart": "restart",
        }
        for prom_key, ali_key in keywords.items():
            if prom_key in q and ali_key in metric_name.lower():
                return True
        return False

    @staticmethod
    def _is_apm_only_query(query: str) -> bool:
        """Check if a PromQL query should only match APM metrics."""
        q = query.lower()
        for prom_name in AliDataMetricTool.PROMQL_APM_ONLY:
            if prom_name in q:
                return True
        return False

    @staticmethod
    def _to_prom_values(values: List, timestamps: List) -> List:
        """Convert AliData {values, timestamps} to Prometheus [[ts_s, "val"]]."""
        result = []
        for i, v in enumerate(values):
            if i < len(timestamps):
                # AliData timestamps are in nanoseconds
                ts = timestamps[i]
                if ts > 1e15:  # nanoseconds
                    ts_s = ts / 1e9
                elif ts > 1e12:  # microseconds
                    ts_s = ts / 1e6
                elif ts > 1e9:  # milliseconds
                    ts_s = ts / 1e3
                else:
                    ts_s = ts
            else:
                ts_s = time.time()
            result.append([ts_s, str(v)])
        return result

    def _parameters_schema(self):
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Metric name filter (e.g. pod_cpu_usage_rate)"},
                "query_type": {"type": "string", "enum": ["instant", "range"], "default": "instant"},
                "start": {"type": "string", "description": "Start time (unix timestamp)"},
                "end": {"type": "string", "description": "End time (unix timestamp)"},
                "namespace": {"type": "string"},
                "natural_language": {"type": "string", "description": "Natural language metric query"},
            },
        }

    def health_check(self) -> bool:
        try:
            s, e = _parse_time_range("5m")
            data = _run_async(self.downloader._download_metric_data(s, e))
            return data is not None
        except Exception:
            return False


# ═══════════════════════════════════════════
#  AliData Log Tool (replaces Elasticsearch)
# ═══════════════════════════════════════════

class AliDataLogTool(SRETool):
    """
    Fetches logs from Alibaba Cloud SLS/ARMS via DataDownloader,
    converts to Elasticsearch-compatible format for LogAgent consumption.
    """

    name = "elasticsearch"
    description = "Fetch logs from AliData (SLS/ARMS) — Elasticsearch-compatible adapter"

    def __init__(self, downloader):
        self.downloader = downloader

    def _execute(self, query: str = "", index: str = "",
                 time_range: str = "1h", level: str = "",
                 size: int = 100, namespace: str = "") -> ToolResult:
        try:
            s, e = _parse_time_range(time_range)
            data = _run_async(self.downloader._download_log_data(s, e))
            if not data:
                return ToolResult(success=True, data={
                    "total_hits": 0, "returned": 0, "entries": [],
                })

            entries = []
            for item in data:
                if not isinstance(item, dict):
                    continue

                # Namespace filter
                item_ns = item.get("namespace", "")
                if namespace and item_ns and namespace.lower() != item_ns.lower():
                    continue

                # Extract message from properties
                message = self._extract_message(item)

                # Level extraction
                item_level = item.get("log_type", "info")
                if "error" in item_level.lower():
                    item_level = "error"
                elif "warn" in item_level.lower():
                    item_level = "warn"
                else:
                    item_level = "info"

                # Level filter
                if level and level.lower() != item_level.lower():
                    continue

                # Query keyword filter
                if query:
                    searchable = f"{message} {item.get('service_name', '')} {item.get('pod_name', '')}"
                    if query.lower() not in searchable.lower():
                        continue

                entries.append({
                    "timestamp": item.get("__time__", item.get("timestamp", "")),
                    "level": item_level,
                    "message": message[:500],
                    "pod": item.get("pod_name", item.get("host", "")),
                    "namespace": item_ns,
                    "service": item.get("service_name", ""),
                })

                if len(entries) >= size:
                    break

            return ToolResult(success=True, data={
                "total_hits": len(entries),
                "returned": len(entries),
                "entries": entries,
            })

        except Exception as e:
            logger.error(f"AliDataLogTool error: {e}")
            return ToolResult(success=False, error=str(e))

    @staticmethod
    def _extract_message(item: dict) -> str:
        """Extract a human-readable message from AliData log entry."""
        # Try direct message field
        if "message" in item:
            return str(item["message"])

        # Extract from properties JSON
        props_raw = item.get("properties", "")
        if props_raw and isinstance(props_raw, str):
            try:
                props = json.loads(props_raw)
                # Build a concise message from agent properties
                parts = []
                if "agent_version" in props:
                    parts.append(f"agent={props['agent_version']}")
                if "agent_env" in props:
                    parts.append(f"env={props['agent_env']}")
                if "runtime_version" in props:
                    parts.append(f"runtime={props['runtime_version']}")
                if "agent_status" in props:
                    status = "running" if props["agent_status"] == 1 else "stopped"
                    parts.append(f"status={status}")
                if parts:
                    return f"[{item.get('service_name', 'unknown')}] {', '.join(parts)}"
            except (json.JSONDecodeError, TypeError):
                pass

        # Fallback: combine available fields
        svc = item.get("service_name", "")
        log_type = item.get("log_type", "")
        source = item.get("source", "")
        return f"[{source}] {log_type}: service={svc}, pod={item.get('pod_name', '')}"

    def _parameters_schema(self):
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query keyword"},
                "time_range": {"type": "string", "default": "1h"},
                "level": {"type": "string", "enum": ["", "error", "warn", "info"]},
                "size": {"type": "integer", "default": 100},
                "namespace": {"type": "string"},
            },
        }

    def health_check(self) -> bool:
        try:
            s, e = _parse_time_range("5m")
            data = _run_async(self.downloader._download_log_data(s, e))
            return data is not None
        except Exception:
            return False


# ═══════════════════════════════════════════
#  AliData Trace Tool (replaces Jaeger)
# ═══════════════════════════════════════════

class AliDataTraceTool(SRETool):
    """
    Fetches distributed traces from Alibaba Cloud ARMS via DataDownloader,
    converts to Jaeger-compatible format for TraceAgent consumption.
    """

    name = "jaeger"
    description = "Fetch traces from AliData (ARMS) — Jaeger-compatible adapter"

    def __init__(self, downloader):
        self.downloader = downloader

    def _execute(self, service: str = "", operation: str = "",
                 min_duration: str = "", max_duration: str = "",
                 limit: int = 20, lookback: str = "1h",
                 trace_id: str = "") -> ToolResult:
        try:
            s, e = _parse_time_range(lookback)
            data = _run_async(self.downloader._download_trace_data(s, e))
            if not data:
                # Return services list if no service specified
                if not service and not trace_id:
                    return ToolResult(success=True, data={"data": []})
                return ToolResult(success=True, data={
                    "service": service, "trace_count": 0, "traces": [],
                })

            # Exact trace lookup
            if trace_id:
                matching = [sp for sp in data if sp.get("trace_id") == trace_id]
                if matching:
                    return ToolResult(success=True, data=self._spans_to_trace(matching))
                return ToolResult(success=True, data={
                    "service": "", "trace_count": 0, "traces": [],
                })

            # List services (no service specified)
            if not service:
                services = list(set(sp.get("service_name", "") for sp in data if sp.get("service_name")))
                return ToolResult(success=True, data={"data": services})

            # Filter by service
            filtered = [sp for sp in data if sp.get("service_name", "") == service]

            # Filter by operation
            if operation:
                filtered = [sp for sp in filtered if sp.get("operation_name", "") == operation]

            # Group spans by trace_id → trace summaries
            traces_by_id = defaultdict(list)
            for sp in filtered:
                traces_by_id[sp.get("trace_id", "unknown")].append(sp)

            summaries = []
            for tid, spans in list(traces_by_id.items())[:limit]:
                summaries.append(self._build_trace_summary(tid, spans))

            return ToolResult(success=True, data={
                "service": service,
                "trace_count": len(summaries),
                "traces": summaries,
            })

        except Exception as e:
            logger.error(f"AliDataTraceTool error: {e}")
            return ToolResult(success=False, error=str(e))

    @staticmethod
    def _build_trace_summary(trace_id: str, spans: List[Dict]) -> Dict:
        """
        Build a Jaeger-compatible trace summary from AliData spans,
        enriched with business-level fields extracted from tags.
        """
        services_in_trace = list(set(
            sp.get("service_name", "") for sp in spans
        ))
        durations_us = [sp.get("duration_ms", 0) * 1000 for sp in spans]

        # ── Extract business signals from span tags ──
        http_status_codes = []
        error_spans = []
        operations = []
        endpoints = []

        for sp in spans:
            # Parse tags JSON
            tags_raw = sp.get("tags", "{}")
            tags = tags_raw if isinstance(tags_raw, dict) else {}
            if isinstance(tags_raw, str):
                try:
                    tags = json.loads(tags_raw)
                except (json.JSONDecodeError, TypeError):
                    tags = {}

            # HTTP status code
            status = tags.get("http.status_code", tags.get("status", ""))
            if status:
                http_status_codes.append(str(status))
                if str(status).startswith(("4", "5")):
                    error_spans.append({
                        "span_id": sp.get("span_id", ""),
                        "service": sp.get("service_name", ""),
                        "operation": sp.get("operation_name", ""),
                        "status_code": str(status),
                        "url": tags.get("http.url", ""),
                        "duration_ms": sp.get("duration_ms", 0),
                    })

            # Operation / endpoint
            op = sp.get("operation_name", "")
            if op:
                operations.append(op)
            url = tags.get("http.url", "")
            if url:
                endpoints.append(url)

            # Extract K8S metadata from raw_span.resources
            raw_span = sp.get("raw_span", {})
            res_raw = raw_span.get("resources", "{}")
            if isinstance(res_raw, str):
                try:
                    res = json.loads(res_raw)
                except (json.JSONDecodeError, TypeError):
                    res = {}
            else:
                res = res_raw
            ns = res.get("k8s.namespace.name", "")
            if ns and ns not in services_in_trace:
                # Attach namespace info
                pass

        # Build enriched summary (Jaeger-compatible + business extensions)
        summary = {
            "traceID": trace_id,
            "span_count": len(spans),
            "services": services_in_trace,
            "total_duration_us": max(durations_us) if durations_us else 0,
            "avg_duration_us": int(sum(durations_us) / max(len(durations_us), 1)),
        }

        # Business enrichment (extra fields — Agent/LLM can use for analysis)
        if operations:
            summary["operations"] = list(set(operations))
        if endpoints:
            summary["endpoints"] = list(set(endpoints))[:10]
        if http_status_codes:
            from collections import Counter
            status_dist = dict(Counter(http_status_codes))
            summary["http_status_distribution"] = status_dist
            summary["error_rate"] = sum(
                1 for s in http_status_codes if s.startswith(("4", "5"))
            ) / len(http_status_codes)
        if error_spans:
            summary["error_spans"] = error_spans[:10]

        return summary

    @staticmethod
    def _spans_to_trace(spans: List[Dict]) -> Dict:
        """Convert a list of AliData spans into a single Jaeger-style trace."""
        summary = AliDataTraceTool._build_trace_summary(
            spans[0].get("trace_id", ""), spans
        )
        return {
            "service": summary["services"][0] if summary["services"] else "",
            "trace_count": 1,
            "traces": [summary],
        }

    def _parameters_schema(self):
        return {
            "type": "object",
            "properties": {
                "service": {"type": "string"},
                "operation": {"type": "string"},
                "min_duration": {"type": "string"},
                "max_duration": {"type": "string"},
                "limit": {"type": "integer", "default": 20},
                "lookback": {"type": "string", "default": "1h"},
                "trace_id": {"type": "string"},
            },
        }

    def health_check(self) -> bool:
        try:
            s, e = _parse_time_range("5m")
            data = _run_async(self.downloader._download_trace_data(s, e))
            return data is not None
        except Exception:
            return False
