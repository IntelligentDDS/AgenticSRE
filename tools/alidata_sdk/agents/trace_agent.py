"""
Real Trace Agent for RCA Data Collection - Using Real MCP Data
"""
import logging
from datetime import datetime
from typing import List, Dict, Any
from ..utils.evidence_chain import EvidenceChain


class MinimalTraceAgent:
    """Minimal trace agent for data collection - 支持离线模式"""
    
    def __init__(
        self,
        debug: bool = False,
        offline_mode: bool = False,
        problem_id: str = None,
        data_dir: str = None,
    ):
        self.debug = debug
        self.offline_mode = offline_mode
        self.problem_id = problem_id
        self.logger = logging.getLogger(__name__)
        
        if offline_mode:
            # 离线模式：使用本地数据加载器
            from ..utils.local_data_loader import get_local_data_loader
            self.local_loader = get_local_data_loader(data_dir=data_dir, debug=debug)
            self.logger.info(f"✅ MinimalTraceAgent初始化完成 (离线模式, 问题ID: {problem_id})")
        else:
            
            self.logger.info(f"✅ MinimalTraceAgent初始化完成 (在线模式)")
        
    def _fetch_mcp_trace_data(self, start_time: datetime, end_time: datetime) -> List[Dict[str, Any]]:
        """Fetch real trace data from MCP server."""
        from tools.alidata_sdk.rca_tools.paas_data_tools import (
            umodel_search_traces,
            umodel_get_traces,
        )
        try:
            start_timestamp = int(start_time.timestamp())
            end_timestamp = int(end_time.timestamp())
            
            # Use real MCP trace search and get methods
            spans = []
            
            # First search for trace IDs
            search_result = umodel_search_traces.invoke({
                "domain": "apm",
                "entity_set_name": "apm.service",
                "trace_set_domain": "apm", 
                "trace_set_name": "apm.trace.common",
                "from_time": start_timestamp,
                "to_time": end_timestamp,
                "limit": 50
            })
            
            # Parse LangChain response format
            trace_ids = []
            if search_result and not search_result.error and search_result.data:
                content = search_result.data
                
                # Extract trace IDs from content - correct parsing logic
                for item in content:
                    if isinstance(item, dict):
                        trace_id = item.get('traceId')
                        if trace_id:
                            trace_ids.append(trace_id)
                
                # Get detailed spans for each trace ID
                for trace_id in trace_ids:  # Limit to 20 traces
                    trace_result = umodel_get_traces.invoke({
                        "domain": "apm",
                        "entity_set_name": "apm.service",
                        "trace_ids": [trace_id],  # Now properly a list
                        "trace_set_domain": "apm",
                        "trace_set_name": "apm.trace.common", 
                        "from_time": start_timestamp,  # 添加时间参数 - 关键修复！
                        "to_time": end_timestamp       # 添加时间参数 - 关键修复！
                    })
                    
                    # Parse trace spans from response
                    if trace_result and not trace_result.error and trace_result.data:
                        content = trace_result.data
                        
                        # Extract spans from content
                        for span_item in content:
                            spans.extend([span_item])

            formatted_spans = []
            for span in spans:
                try:
                    # Parse span data with correct field mapping
                    formatted_span = {
                        'trace_id': span.get('traceId', ''),        # 修复：正确字段名
                        'span_id': span.get('spanId', ''),          # 修复：正确字段名
                        'service_name': span.get('serviceName', ''), # 修复：正确字段名
                        'operation_name': span.get('spanName', ''),  # 修复：正确字段名
                        'start_time': span.get('startTime', 0),      # 修复：正确字段名
                        'duration_ms': float(span.get('duration_ms', 0)),  # 修复：已经是ms
                        'status_code': span.get('statusCode', 0),    # 修复：正确字段名
                        'tags': span.get('attributes', {}),         # 修复：使用attributes作为tags
                        'raw_span': span
                    }
                    formatted_spans.append(formatted_span)
                    
                except Exception as e:
                    self.logger.debug(f"Failed to parse span: {e}")
                    continue
            
            self.logger.info(f"✅ Fetched {len(formatted_spans)} trace spans")
            return formatted_spans
            
        except Exception as e:
            self.logger.error(f"❌ Failed to fetch trace data: {e}")
            return []
    
    def analyze_high_latency_spans(self, traces: List[Dict[str, Any]], 
                                  percentile_threshold: float = 95.0) -> List[Dict[str, Any]]:
        """Analyze high latency spans."""
        if not traces:
            return []
        
        # Calculate latency percentile
        durations = [trace['duration_ms'] for trace in traces if trace['duration_ms'] > 0]
        if not durations:
            return []
        
        durations.sort()
        p_index = int(len(durations) * percentile_threshold / 100)
        threshold = durations[min(p_index, len(durations) - 1)]
        
        # Find high latency spans
        high_latency_spans = [
            trace for trace in traces 
            if trace['duration_ms'] >= threshold
        ]
        
        return high_latency_spans[:10]  # Return top 10
    
    def _fetch_trace_data(self, start_time: datetime, end_time: datetime) -> List[Dict[str, Any]]:
        """根据模式获取链路数据"""
        if self.offline_mode:
            # 离线模式：从本地文件加载数据
            if not self.problem_id:
                self.logger.error("❌ 离线模式需要指定problem_id")
                return []
            
            # 判断是故障期还是基线期数据
            duration_minutes = (end_time - start_time).total_seconds() / 60
            data_type = "failure" if duration_minutes <= 10 else "baseline"
            
            self.logger.info(f"🔗 从本地加载 {self.problem_id} {data_type} 链路数据")
            return self.local_loader.load_traces(self.problem_id, data_type)
        else:
            # 在线模式：从MCP服务获取数据
            return self._fetch_mcp_trace_data(start_time, end_time)
    
    def analyze(self, evidence_chain: EvidenceChain) -> Dict[str, Any]:
        """分析链路数据 - 支持离线模式"""
        
        mode_desc = "离线模式" if self.offline_mode else "在线模式"
        self.logger.info(f"🔗 开始链路分析 ({mode_desc})")
        
        # 获取链路数据 - 根据模式选择数据源
        trace_data = self._fetch_trace_data(evidence_chain.start_time, evidence_chain.end_time)
        
        # 分析高延迟spans
        high_latency = self.analyze_high_latency_spans(trace_data)
        
        # 添加证据
        source_desc = f"{mode_desc}_trace_analysis"
        evidence_chain.add_evidence('trace', source_desc, trace_data, confidence=0.6)
        
        self.logger.info(f"✅ 链路分析完成 ({mode_desc})")
        self.logger.info(f"   Span数量: {len(trace_data)}")
        self.logger.info(f"   服务数量: {len(set(trace.get('service_name', 'unknown') for trace in trace_data))}")
        self.logger.info(f"   高延迟数量: {len(high_latency)}")
        
        return {
            'span_count': len(trace_data),
            'services': list(set(trace.get('service_name', 'unknown') for trace in trace_data)),
            'high_latency_count': len(high_latency),
            'avg_duration_ms': sum(trace['duration_ms'] for trace in trace_data) / len(trace_data) if trace_data else 0
        }
