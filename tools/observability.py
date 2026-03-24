"""
AgenticSRE Observability Tools
Prometheus, Elasticsearch, and Jaeger client tools.
"""

import json
import time
import logging
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import requests

from tools.base_tool import SRETool, ToolResult

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════
#  Prometheus Tool
# ═══════════════════════════════════════════

class PrometheusTool(SRETool):
    """Query Prometheus for metrics with PromQL, supports instant & range queries."""

    name = "prometheus"
    description = "Execute PromQL queries against Prometheus for metric data"

    def __init__(self, base_url: str = "", llm_client=None):
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.llm = llm_client
        self.session = requests.Session()

    def _execute(self, query: str = "", query_type: str = "instant",
                 start: str = "", end: str = "", step: str = "60s",
                 natural_language: str = "") -> ToolResult:
        if not self.base_url:
            return self._stub_execute(query or natural_language)

        # Natural language → PromQL via LLM
        if natural_language and not query and self.llm:
            query = self._nl_to_promql(natural_language)

        if not query:
            return ToolResult(success=False, error="No query provided")

        try:
            if query_type == "range":
                url = f"{self.base_url}/api/v1/query_range"
                params = {"query": query, "step": step}
                if start:
                    params["start"] = start
                else:
                    params["start"] = str(int(time.time()) - 3600)  # last 1h
                if end:
                    params["end"] = end
                else:
                    params["end"] = str(int(time.time()))
            else:
                url = f"{self.base_url}/api/v1/query"
                params = {"query": query}

            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()

            if data.get("status") == "success":
                results = data.get("data", {}).get("result", [])
                return ToolResult(success=True, data={
                    "query": query,
                    "result_count": len(results),
                    "results": results[:50],  # limit for LLM context
                })
            else:
                return ToolResult(success=False, error=data.get("error", "Unknown error"))

        except requests.Timeout:
            return ToolResult(success=False, error="Prometheus query timed out")
        except Exception as e:
            return ToolResult(success=False, error=str(e))

    def _nl_to_promql(self, nl: str) -> str:
        """Convert natural language to PromQL using LLM."""
        if not self.llm:
            return nl
        try:
            result = self.llm.chat([
                {"role": "system", "content": (
                    "You are a Prometheus PromQL expert. Convert the natural language query to a valid PromQL expression. "
                    "Return ONLY the PromQL query, nothing else."
                )},
                {"role": "user", "content": nl}
            ])
            return result.strip().strip('`').strip()
        except Exception:
            return nl

    def _stub_execute(self, query: str) -> ToolResult:
        return ToolResult(
            success=True,
            data={"query": query, "results": [], "note": "STUB - no Prometheus configured"},
            source=self.name,
        )

    def _parameters_schema(self):
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "PromQL query"},
                "query_type": {"type": "string", "enum": ["instant", "range"], "default": "instant"},
                "start": {"type": "string", "description": "Range query start (RFC3339 or unix timestamp)"},
                "end": {"type": "string", "description": "Range query end"},
                "step": {"type": "string", "description": "Range query step", "default": "60s"},
                "natural_language": {"type": "string", "description": "Natural language metric query"},
            },
        }

    def health_check(self) -> bool:
        if not self.base_url:
            return False
        try:
            resp = self.session.get(f"{self.base_url}/-/healthy", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False


# ═══════════════════════════════════════════
#  Elasticsearch Tool
# ═══════════════════════════════════════════

class ElasticsearchTool(SRETool):
    """Search Elasticsearch for log data."""

    name = "elasticsearch"
    description = "Search Elasticsearch for log entries by keyword, time range, and severity level"

    def __init__(self, base_url: str = ""):
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.session = requests.Session()

    def _execute(self, query: str = "", index: str = "filebeat-*",
                 time_range: str = "1h", level: str = "",
                 size: int = 100, namespace: str = "") -> ToolResult:
        if not self.base_url:
            return self._stub_execute(query)

        try:
            # Build ES query
            must_clauses = []
            if query:
                must_clauses.append({"query_string": {"query": query}})
            if level:
                must_clauses.append({"match": {"level": level}})
            if namespace:
                must_clauses.append({"match": {"kubernetes.namespace": namespace}})

            # Time range
            now_ms = int(time.time() * 1000)
            hours = int(time_range.replace("h", "").replace("m", "")) if time_range else 1
            multiplier = 3600000 if "h" in time_range else 60000
            gte = now_ms - hours * multiplier

            must_clauses.append({
                "range": {"@timestamp": {"gte": gte, "lte": now_ms, "format": "epoch_millis"}}
            })

            body = {
                "query": {"bool": {"must": must_clauses}},
                "sort": [{"@timestamp": {"order": "desc"}}],
                "size": min(size, 500),
            }

            url = f"{self.base_url}/{index}/_search"
            resp = self.session.post(url, json=body, timeout=30)
            resp.raise_for_status()
            data = resp.json()

            hits = data.get("hits", {})
            total = hits.get("total", {}).get("value", 0) if isinstance(hits.get("total"), dict) else hits.get("total", 0)
            entries = []
            for hit in hits.get("hits", []):
                src = hit.get("_source", {})
                entries.append({
                    "timestamp": src.get("@timestamp", ""),
                    "level": src.get("level", src.get("log", {}).get("level", "")),
                    "message": src.get("message", "")[:500],
                    "pod": src.get("kubernetes", {}).get("pod", {}).get("name", ""),
                    "namespace": src.get("kubernetes", {}).get("namespace", ""),
                })

            return ToolResult(success=True, data={
                "total_hits": total,
                "returned": len(entries),
                "entries": entries,
            })
        except Exception as e:
            return ToolResult(success=False, error=str(e))

    def _stub_execute(self, query: str) -> ToolResult:
        return ToolResult(
            success=True,
            data={"query": query, "entries": [], "note": "STUB - no Elasticsearch configured"},
        )

    def _parameters_schema(self):
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "index": {"type": "string", "default": "filebeat-*"},
                "time_range": {"type": "string", "default": "1h"},
                "level": {"type": "string", "enum": ["", "error", "warn", "info", "debug"]},
                "size": {"type": "integer", "default": 100},
                "namespace": {"type": "string"},
            },
        }

    def health_check(self) -> bool:
        if not self.base_url:
            return False
        try:
            resp = self.session.get(f"{self.base_url}/_cluster/health", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False


# ═══════════════════════════════════════════
#  Jaeger Tool
# ═══════════════════════════════════════════

class JaegerTool(SRETool):
    """Query Jaeger for distributed traces."""

    name = "jaeger"
    description = "Fetch distributed traces from Jaeger by service, operation, and duration"

    def __init__(self, base_url: str = ""):
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.session = requests.Session()

    def _execute(self, service: str = "", operation: str = "",
                 min_duration: str = "", max_duration: str = "",
                 limit: int = 20, lookback: str = "1h",
                 trace_id: str = "") -> ToolResult:
        if not self.base_url:
            return self._stub_execute(service)

        try:
            if trace_id:
                url = f"{self.base_url}/api/traces/{trace_id}"
                resp = self.session.get(url, timeout=30)
                resp.raise_for_status()
                return ToolResult(success=True, data=resp.json())

            if not service:
                # List available services
                url = f"{self.base_url}/api/services"
                resp = self.session.get(url, timeout=10)
                resp.raise_for_status()
                return ToolResult(success=True, data=resp.json())

            params = {"service": service, "limit": limit, "lookback": lookback}
            if operation:
                params["operation"] = operation
            if min_duration:
                params["minDuration"] = min_duration
            if max_duration:
                params["maxDuration"] = max_duration

            url = f"{self.base_url}/api/traces"
            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()

            traces = data.get("data", [])
            summaries = []
            for trace in traces[:limit]:
                spans = trace.get("spans", [])
                services_in_trace = list(set(
                    s.get("process", {}).get("serviceName", "") for s in spans
                ))
                durations = [s.get("duration", 0) for s in spans]
                summaries.append({
                    "traceID": trace.get("traceID", ""),
                    "span_count": len(spans),
                    "services": services_in_trace,
                    "total_duration_us": max(durations) if durations else 0,
                    "avg_duration_us": sum(durations) // max(len(durations), 1),
                })

            return ToolResult(success=True, data={
                "service": service,
                "trace_count": len(summaries),
                "traces": summaries,
            })
        except Exception as e:
            return ToolResult(success=False, error=str(e))

    def _stub_execute(self, service: str) -> ToolResult:
        return ToolResult(
            success=True,
            data={"service": service, "traces": [], "note": "STUB - no Jaeger configured"},
        )

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
        if not self.base_url:
            return False
        try:
            resp = self.session.get(f"{self.base_url}/api/services", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False
