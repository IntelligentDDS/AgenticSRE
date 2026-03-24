"""
AgenticSRE RCA Engine
Core hypothesis-driven RCA loop: the heart of the system.
Implements: Discovery → Hypothesis → Plan → Investigate → Reason
"""

import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from configs.config_loader import get_config
from tools import build_tool_registry, LLMClient, ToolRegistry
from agents import (
    MetricAgent, LogAgent, TraceAgent, EventAgent,
    HypothesisAgent, CorrelationAgent, PlanningAgent,
    RemediationAgent, AlertAgent, ProfilingAgent,
)
from memory import FaultContextStore, ContextLearner, RCAJudge, TraceStore, AgentTrace
from observability import AgentTracer, MetricsCollector
from orchestrator.session import RCASession

logger = logging.getLogger(__name__)


# ── Final LLM Report Prompt ──

FINAL_REPORT_PROMPT = """You are an expert SRE producing the final Root Cause Analysis report.

Incident: {incident}

Hypotheses (ranked by confidence):
{hypotheses}

Evidence from investigation:
{evidence}

Cross-signal correlation:
{correlation}

Produce a comprehensive, structured RCA report in JSON:
{{
    "root_cause": "specific, actionable root cause statement",
    "confidence": 0.85,
    "fault_type": "category of fault",
    "affected_services": ["svc1", "svc2"],
    "timeline": [
        {{"time": "approximate time", "event": "what happened"}}
    ],
    "evidence_summary": {{
        "metrics": "key metric findings",
        "logs": "key log findings",
        "traces": "key trace findings",
        "events": "key event findings"
    }},
    "reasoning_chain": "step-by-step reasoning from evidence to conclusion",
    "remediation_suggestion": "recommended fix",
    "prevention": "how to prevent recurrence"
}}"""


async def run_rca(
    incident_query: str,
    namespace: str = "",
    config=None,
    log_callback: Optional[Callable] = None,
    registry: Optional[ToolRegistry] = None,
) -> Dict:
    """
    Execute the full hypothesis-driven RCA pipeline.
    
    Flow:
    1. Build ToolRegistry → Init Memory → Historical Context
    2. Generate hypotheses (with historical injection)
    3. Iterative evidence loop (Metric/Log/Trace/Event agents in parallel)
    4. Cross-signal correlation
    5. Graph-based RCA localization
    6. Final LLM report
    7. Quality judge → Auto-learning
    8. Optional self-healing
    """
    cfg = config or get_config()
    session_id = f"rca-{uuid.uuid4().hex[:8]}"
    session = RCASession(
        session_id=session_id,
        incident_query=incident_query,
        namespace=namespace,
        status="running",
    )

    def log(msg: str):
        session.log(msg)
        logger.info(msg)
        if log_callback:
            log_callback(msg)

    def emit(event: dict):
        """Emit structured event through log_callback."""
        if log_callback:
            log_callback(event)

    try:
        # ── Step 0: Setup ──
        log("🔧 Initializing tools and agents...")
        if registry is None:
            registry = build_tool_registry(cfg, allow_write=cfg.runtime.enable_self_healing)
        
        llm = LLMClient(cfg.llm)
        
        # Init agents
        metric_agent = MetricAgent(llm, registry)
        log_agent = LogAgent(llm, registry)
        trace_agent = TraceAgent(llm, registry)
        event_agent = EventAgent(llm, registry)
        hypothesis_agent = HypothesisAgent(llm)
        correlation_agent = CorrelationAgent(llm)
        planning_agent = PlanningAgent(llm, registry)

        # Init memory
        store = FaultContextStore(cfg) if cfg.memory.enabled else None
        learner = ContextLearner(llm, store, cfg) if store else None
        judge = RCAJudge(llm, cfg)
        trace_store = TraceStore(cfg)
        
        # Start pipeline trace
        pipe_trace = trace_store.start_pipeline(session_id, incident_query)

        # ── Step 1: Historical Context ──
        session.add_phase(1, "CONTEXT_RETRIEVAL")
        emit({"event": "phase_start", "phase": 1, "name": "CONTEXT_RETRIEVAL"})
        log("📚 Retrieving historical context...")
        historical = store.get_historical_context(incident_query) if store else {"rules": [], "faults": []}
        rules = [r.get("text", r.get("condition", "")) for r in historical.get("rules", [])]
        faults = historical.get("faults", [])
        log(f"  Found {len(rules)} similar rules, {len(faults)} similar faults")
        session.complete_phase(1)
        emit({"event": "phase_complete", "phase": 1, "name": "CONTEXT_RETRIEVAL", "notes": f"{len(rules)} rules, {len(faults)} faults"})

        # ── Step 2: Hypothesis Generation ──
        session.add_phase(2, "HYPOTHESIS_GENERATION")
        emit({"event": "phase_start", "phase": 2, "name": "HYPOTHESIS_GENERATION"})
        log("🧠 Generating root cause hypotheses...")
        session.hypotheses = hypothesis_agent.generate(
            incident_query, historical_rules=rules, historical_faults=faults
        )
        for h in session.hypotheses:
            log(f"  [{h.id}] (conf={h.confidence:.2f}) {h.description[:100]}")
        session.complete_phase(2, notes=f"{len(session.hypotheses)} hypotheses generated")
        emit({"event": "phase_complete", "phase": 2, "name": "HYPOTHESIS_GENERATION", "notes": f"{len(session.hypotheses)} hypotheses generated"})
        emit({"event": "hypotheses", "items": [{"id": h.id, "confidence": h.confidence, "description": h.description[:150]} for h in session.hypotheses]})

        # ── Step 3: Iterative Evidence Loop ──
        max_iter = cfg.pipeline.max_evidence_iterations
        confidence_threshold = cfg.pipeline.hypothesis_confidence_threshold
        
        for iteration in range(max_iter):
            session.current_iteration = iteration + 1
            session.add_phase(3, f"INVESTIGATION_ITER_{iteration+1}")
            emit({"event": "iteration", "current": iteration + 1, "total": max_iter})
            emit({"event": "phase_start", "phase": 3, "name": f"INVESTIGATION_ITER_{iteration+1}"})
            log(f"\n🔍 Investigation iteration {iteration+1}/{max_iter}")

            # Generate plan
            plan = planning_agent.generate_plan(
                [h.to_dict() for h in session.hypotheses],
                incident_query, iteration
            )
            log(f"  📋 Plan: {len(plan.get('plan', []))} steps")

            # Run domain agents in parallel
            log("  Running domain agents in parallel...")
            start_time = time.time()

            results = await asyncio.gather(
                metric_agent.analyze(incident_query, namespace),
                log_agent.analyze(incident_query, namespace),
                trace_agent.analyze(incident_query, namespace=namespace),
                event_agent.analyze(incident_query, namespace),
                return_exceptions=True,
            )

            # Collect results
            agent_names = ["metric_agent", "log_agent", "trace_agent", "event_agent"]
            new_evidence = {}
            for name, result in zip(agent_names, results):
                if isinstance(result, Exception):
                    log(f"  ⚠️ {name} failed: {result}")
                    new_evidence[name] = {"summary": f"Error: {result}", "error": True}
                    emit({"event": "evidence", "agent": name, "summary": f"Error: {result}", "success": False})
                else:
                    log(f"  ✅ {name}: {result.get('summary', '')[:100]}")
                    new_evidence[name] = result
                    session.evidence[name] = result
                    emit({"event": "evidence", "agent": name, "summary": result.get("summary", "")[:200], "success": True})

            elapsed = time.time() - start_time
            log(f"  Evidence collection: {elapsed:.1f}s")

            # Re-rank hypotheses
            log("  Re-ranking hypotheses...")
            session.hypotheses = hypothesis_agent.rerank(session.hypotheses, new_evidence)
            top = session.top_hypothesis()
            if top:
                log(f"  Top hypothesis: [{top.id}] conf={top.confidence:.2f} — {top.description[:80]}")
            emit({"event": "hypotheses", "items": [{"id": h.id, "confidence": h.confidence, "description": h.description[:150]} for h in session.hypotheses]})

            session.iterations.append({
                "iteration": iteration + 1,
                "evidence_agents": list(new_evidence.keys()),
                "top_confidence": top.confidence if top else 0,
                "duration_s": round(elapsed, 1),
            })
            session.complete_phase(3, notes=f"Top confidence: {top.confidence:.2f}" if top else "")
            emit({"event": "phase_complete", "phase": 3, "name": f"INVESTIGATION_ITER_{iteration+1}", "notes": f"Top confidence: {top.confidence:.2f}" if top else ""})

            # Early exit if high confidence
            if top and top.confidence >= confidence_threshold:
                log(f"  🎯 High confidence reached ({top.confidence:.2f} ≥ {confidence_threshold}), stopping iterations")
                break

        # ── Step 4: Cross-Signal Correlation ──
        if cfg.pipeline.enable_correlation:
            session.add_phase(4, "CORRELATION")
            emit({"event": "phase_start", "phase": 4, "name": "CORRELATION"})
            log("\n🔗 Running cross-signal correlation...")
            try:
                correlation_result = correlation_agent.correlate(session.evidence)
                session.evidence["correlation"] = correlation_result
                log(f"  Top suspect: {correlation_result.get('top_suspect', 'N/A')}")
            except Exception as e:
                correlation_result = {}
                log(f"  ⚠️ Correlation failed: {e}")
            session.complete_phase(4)
            emit({"event": "phase_complete", "phase": 4, "name": "CORRELATION"})
        else:
            correlation_result = {}

        # ── Step 5: Graph RCA Localization ──
        if cfg.pipeline.enable_graph_rca:
            session.add_phase(5, "GRAPH_RCA")
            emit({"event": "phase_start", "phase": 5, "name": "GRAPH_RCA"})
            log("\n📊 Running graph-based RCA localization...")
            try:
                rca_tool = registry.get("rca_localization")
                if rca_tool and correlation_result:
                    ranked = correlation_result.get("anomaly_matrix", {}).get("ranked_services", [])
                    anomaly_scores = {s["service"]: s["composite_score"] for s in ranked}
                    if anomaly_scores:
                        rca_result = rca_tool.execute(anomaly_scores=anomaly_scores)
                        if rca_result.success:
                            session.evidence["graph_rca"] = rca_result.data
                            log(f"  Graph RCA top: {rca_result.data.get('top_root_cause', 'N/A')}")
            except Exception as e:
                log(f"  ⚠️ Graph RCA failed: {e}")
            session.complete_phase(5)
            emit({"event": "phase_complete", "phase": 5, "name": "GRAPH_RCA"})

        # ── Step 6: Final Report ──
        session.add_phase(6, "FINAL_REPORT")
        emit({"event": "phase_start", "phase": 6, "name": "FINAL_REPORT"})
        log("\n📝 Generating final RCA report...")

        hyp_text = "\n".join([
            f"[{h.id}] conf={h.confidence:.2f} — {h.description}"
            for h in session.hypotheses[:5]
        ])
        evidence_text = ""
        for agent, result in session.evidence.items():
            summary = result.get("summary", str(result))[:500]
            evidence_text += f"\n[{agent}]: {summary}\n"

        try:
            final_result = llm.json_chat([
                {"role": "system", "content": "You are an expert SRE producing the final RCA report."},
                {"role": "user", "content": FINAL_REPORT_PROMPT.format(
                    incident=incident_query,
                    hypotheses=hyp_text,
                    evidence=evidence_text[:6000],
                    correlation=str(correlation_result.get("summary", ""))[:2000],
                )}
            ])
        except Exception as e:
            log(f"  ⚠️ LLM report generation failed: {e}, using fallback")
            top = session.top_hypothesis()
            final_result = {
                "root_cause": top.description if top else f"Investigation of: {incident_query}",
                "confidence": top.confidence if top else 0.3,
                "fault_type": "unknown",
                "affected_services": [],
                "timeline": [],
                "evidence_summary": {k: str(v.get("summary", ""))[:200] for k, v in session.evidence.items() if isinstance(v, dict)},
                "reasoning_chain": f"LLM report generation failed ({e}), based on hypothesis analysis",
                "remediation_suggestion": "Investigate the reported incident manually",
                "prevention": "",
            }

        session.result = final_result
        log(f"\n🎯 Root Cause: {final_result.get('root_cause', 'N/A')}")
        log(f"   Confidence: {final_result.get('confidence', 0)}")
        session.complete_phase(6)
        emit({"event": "phase_complete", "phase": 6, "name": "FINAL_REPORT"})
        emit({"event": "result", "data": final_result})

        # ── Step 7: Quality Judge ──
        session.add_phase(7, "QUALITY_JUDGE")
        emit({"event": "phase_start", "phase": 7, "name": "QUALITY_JUDGE"})
        log("\n⚖️ Running quality assessment...")
        try:
            reasoning = final_result.get("reasoning_chain", str(final_result))
            judge_result = judge.judge(
                reasoning=reasoning,
                root_cause=final_result.get("root_cause", ""),
                confidence=final_result.get("confidence", 0),
            )
            log(f"  Judge level: {judge_result['judge_level']}, score: {judge_result['combined_score']:.3f}")
            if judge_result["needs_review"]:
                log("  ⚠️ Flagged for review — low quality reasoning")
        except Exception as e:
            log(f"  ⚠️ Quality judge failed: {e}")
            judge_result = {"judge_level": "bronze", "combined_score": 0.0, "needs_review": True}
        session.complete_phase(7)
        emit({"event": "phase_complete", "phase": 7, "name": "QUALITY_JUDGE"})
        emit({"event": "judge", "data": judge_result})

        # ── Step 8: Auto-Learning ──
        if learner and cfg.memory.auto_learn:
            session.add_phase(8, "AUTO_LEARNING")
            emit({"event": "phase_start", "phase": 8, "name": "AUTO_LEARNING"})
            log("\n📖 Auto-learning from this incident...")
            learn_result = learner.learn_from_trace(
                reasoning_trace=reasoning,
                root_cause=final_result.get("root_cause", ""),
                confidence=final_result.get("confidence", 0),
                judge_level=judge_result["judge_level"],
            )
            learner.store_fault_context(
                incident_query, final_result, session.evidence,
                [h.to_dict() for h in session.hypotheses]
            )
            log(f"  Rules added: {learn_result.get('rules_added', 0)}")
            session.complete_phase(8)
            emit({"event": "phase_complete", "phase": 8, "name": "AUTO_LEARNING"})

        # ── Step 9: Optional Self-Healing ──
        if cfg.pipeline.enable_recovery and final_result.get("confidence", 0) >= cfg.remediation.confidence_threshold:
            session.add_phase(9, "RECOVERY")
            emit({"event": "phase_start", "phase": 9, "name": "RECOVERY"})
            log("\n🛠️ Initiating self-healing...")
            remediation_agent = RemediationAgent(llm, registry, cfg)
            rem_result = await remediation_agent.remediate(final_result, final_result.get("confidence", 0))
            session.evidence["remediation"] = rem_result
            log(f"  Remediation status: {rem_result.get('status', 'N/A')}")
            if rem_result.get("status") == "pending_approval":
                log(f"  📋 Remediation plan generated, waiting for approval")
                plan_actions = rem_result.get("plan", {}).get("actions", [])
                for a in plan_actions:
                    log(f"    [{a.get('risk_level','?')}] {a.get('description','')}")
            emit({"event": "remediation", "data": rem_result})
            session.complete_phase(9)
            emit({"event": "phase_complete", "phase": 9, "name": "RECOVERY"})

        # Complete
        session.status = "completed"
        trace_store.complete_pipeline(session_id, final_result)
        
        return {
            "session_id": session_id,
            "status": "completed",
            "result": final_result,
            "judge": judge_result,
            "hypotheses": [h.to_dict() for h in session.hypotheses],
            "phases": session.phases,
            "iterations": session.iterations,
            "evidence_agents": list(session.evidence.keys()),
        }

    except Exception as e:
        session.status = "failed"
        logger.error(f"RCA pipeline failed: {e}", exc_info=True)
        log(f"\n❌ Pipeline failed: {e}")
        return {
            "session_id": session_id,
            "status": "failed",
            "error": str(e),
            "phases": session.phases,
        }
