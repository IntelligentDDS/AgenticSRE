"""
AgenticSRE Evolution Tracker
Records system improvement snapshots: knowledge base growth, diagnostic accuracy,
response latency trends, and quality judge scores.
SOW: "利用...系统反馈...实现多智能体运维能力的持续演化"
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_SNAPSHOT_DIR = "./data/evolution"


@dataclass
class EvolutionSnapshot:
    """A point-in-time snapshot of system state."""
    timestamp: float = 0.0
    rule_count: int = 0
    fault_context_count: int = 0
    feedback_count: int = 0
    trace_count: int = 0
    rca_confidence: float = 0.0
    rca_latency_s: float = 0.0
    judge_score: float = 0.0
    paradigm_name: str = ""
    incident_query: str = ""


class EvolutionTracker:
    """
    Tracks AgenticSRE system evolution over time.

    Records snapshots after each paradigm/RCA run and provides trend reports.

    Usage:
        tracker = EvolutionTracker.from_config()
        tracker.record_snapshot(fault_store=store, result=result_dict)
        report = tracker.get_evolution_report()
    """

    def __init__(self, snapshot_dir: Optional[str] = None, max_snapshots: int = 1000):
        self._dir = Path(snapshot_dir or _DEFAULT_SNAPSHOT_DIR)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._snapshot_file = self._dir / "snapshots.json"
        self._max = max_snapshots
        self._snapshots: List[EvolutionSnapshot] = []
        self._load()

    @classmethod
    def from_config(cls) -> "EvolutionTracker":
        """Create from global AppConfig."""
        from configs.config_loader import get_config
        cfg = get_config()
        return cls(
            snapshot_dir=cfg.evolution.snapshot_dir or None,
            max_snapshots=cfg.evolution.max_snapshots,
        )

    def _load(self):
        if self._snapshot_file.exists():
            try:
                data = json.loads(self._snapshot_file.read_text(encoding="utf-8"))
                self._snapshots = [EvolutionSnapshot(**s) for s in data[-self._max:]]
            except Exception as e:
                logger.warning("Failed to load evolution snapshots: %s", e)

    def _save(self):
        data = [asdict(s) for s in self._snapshots[-self._max:]]
        self._snapshot_file.write_text(
            json.dumps(data, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )

    def record_snapshot(
        self,
        fault_store=None,
        feedback_store=None,
        trace_store=None,
        rca_result: Optional[Dict] = None,
        paradigm_name: str = "",
        incident_query: str = "",
    ) -> Dict:
        """
        Record a new evolution snapshot.

        Parameters
        ----------
        fault_store     : FaultContextStore instance
        feedback_store  : ExpertFeedbackStore instance
        trace_store     : TraceStore instance
        rca_result      : Result dict from RCA / paradigm run
        paradigm_name   : Name of the paradigm used
        incident_query  : The incident description
        """
        snap = EvolutionSnapshot(timestamp=time.time())

        if fault_store is not None:
            try:
                stats = fault_store.stats()
                snap.rule_count = stats.get("rules_count", 0)
                snap.fault_context_count = stats.get("faults_count", 0)
            except Exception:
                pass

        if feedback_store is not None:
            try:
                fb_stats = feedback_store.get_feedback_stats()
                snap.feedback_count = fb_stats.get("total", 0)
            except Exception:
                pass

        if trace_store is not None:
            try:
                perf = trace_store.get_performance_stats()
                snap.trace_count = perf.get("total_pipelines", 0)
            except Exception:
                pass

        if rca_result is not None:
            result = rca_result.get("result", rca_result)
            snap.rca_confidence = result.get("confidence", 0)
            snap.rca_latency_s = rca_result.get("metrics", {}).get("latency_s", 0)
            judge = rca_result.get("judge", {})
            snap.judge_score = judge.get("combined_score", 0)

        snap.paradigm_name = paradigm_name
        snap.incident_query = (incident_query or "")[:200]

        self._snapshots.append(snap)
        self._save()

        logger.info(
            "[Evolution] Snapshot recorded: rules=%d faults=%d conf=%.2f",
            snap.rule_count, snap.fault_context_count, snap.rca_confidence,
        )
        return asdict(snap)

    def get_evolution_report(self) -> Dict:
        """Generate a comprehensive evolution report with trends."""
        if not self._snapshots:
            return {"total_snapshots": 0, "summary": "No evolution data yet."}

        first = self._snapshots[0]
        last = self._snapshots[-1]
        span_hours = (last.timestamp - first.timestamp) / 3600 if len(self._snapshots) > 1 else 0

        # Compute trends
        confidences = [s.rca_confidence for s in self._snapshots if s.rca_confidence > 0]
        latencies = [s.rca_latency_s for s in self._snapshots if s.rca_latency_s > 0]
        judge_scores = [s.judge_score for s in self._snapshots if s.judge_score > 0]

        mid = len(confidences) // 2
        first_half_conf = sum(confidences[:mid]) / max(mid, 1) if mid > 0 else 0
        second_half_conf = sum(confidences[mid:]) / max(len(confidences) - mid, 1) if confidences else 0

        if second_half_conf > first_half_conf + 0.05:
            trend = "improving"
        elif second_half_conf < first_half_conf - 0.05:
            trend = "declining"
        else:
            trend = "stable"

        return {
            "total_snapshots": len(self._snapshots),
            "time_range": {
                "first": time.strftime("%Y-%m-%d %H:%M", time.localtime(first.timestamp)),
                "last": time.strftime("%Y-%m-%d %H:%M", time.localtime(last.timestamp)),
                "span_hours": round(span_hours, 1),
            },
            "trends": {
                "rule_growth": {
                    "initial": first.rule_count,
                    "current": last.rule_count,
                    "net_growth": last.rule_count - first.rule_count,
                },
                "confidence": {
                    "average": sum(confidences) / max(len(confidences), 1),
                    "latest": confidences[-1] if confidences else 0,
                    "trend": trend,
                },
                "latency": {
                    "average_seconds": sum(latencies) / max(len(latencies), 1),
                    "latest_seconds": latencies[-1] if latencies else 0,
                },
                "judge_quality": {
                    "average_score": sum(judge_scores) / max(len(judge_scores), 1),
                    "reviews_needed": sum(1 for s in judge_scores if s < 0.65),
                },
            },
            "summary": (
                f"System has processed {len(self._snapshots)} incidents over {span_hours:.1f}h. "
                f"Knowledge base: {last.rule_count} rules, {last.fault_context_count} fault contexts. "
                f"Confidence trend: {trend}."
            ),
        }

    def get_trend(self, metric_key: str, window: int = 20) -> List[Dict]:
        """Get recent trend data for a specific metric."""
        recent = self._snapshots[-window:]
        return [
            {
                "timestamp": s.timestamp,
                "value": getattr(s, metric_key, 0),
            }
            for s in recent
            if hasattr(s, metric_key)
        ]
