#!/usr/bin/env python
"""
本地数据加载器
从本地JSON文件加载预下载的MCP数据，提供与MCP相同的接口
"""

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional
import os

class LocalDataLoader:
    """本地数据加载器
    
    从本地文件系统加载预下载的MCP数据，替代实时MCP查询
    """
    
    def __init__(self, data_dir: Optional[str] = None, debug: bool = False):
        self.debug = debug
        self.logger = logging.getLogger(__name__)
        
        # 设置数据目录
        if data_dir:
            self.data_dir = Path(data_dir).expanduser()
        else:
            # 默认使用项目根目录下的 data 文件夹
            project_root = Path(__file__).resolve().parents[3]
            self.data_dir = project_root / "data"
        
        self.data_dir = self.data_dir.resolve()
        
        if not self.data_dir.exists():
            raise FileNotFoundError(f"数据目录不存在: {self.data_dir}")
        
        self.logger.info(f"🔧 本地数据加载器初始化，数据目录: {self.data_dir}")
        
        # 缓存已加载的数据
        self._data_cache = {}
    
    def _get_problem_data_dir(self, problem_id: str) -> Path:
        """获取问题数据目录路径"""
        return self.data_dir / f"problem_{problem_id}"
    
    def _load_json_file(self, file_path: Path) -> Any:
        """加载JSON文件"""
        try:
            if not file_path.exists():
                self.logger.warning(f"⚠️ 文件不存在: {file_path}")
                return None
                
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # 检查是否是错误文件
            if isinstance(data, dict) and 'error' in data:
                self.logger.warning(f"⚠️ 文件包含错误信息: {file_path}")
                return None
                
            return data
            
        except Exception as e:
            self.logger.error(f"❌ 加载文件失败 {file_path}: {e}")
            return None
    
    def get_problem_metadata(self, problem_id: str) -> Optional[Dict[str, Any]]:
        """获取问题的元数据信息"""
        problem_dir = self._get_problem_data_dir(problem_id)
        metadata_path = problem_dir / "metadata.json"
        
        return self._load_json_file(metadata_path)
    
    def load_logs(self, problem_id: str, data_type: str = "failure") -> List[Dict[str, Any]]:
        """加载日志数据
        
        Args:
            problem_id: 问题ID (如 "004")
            data_type: 数据类型 ("failure" 或 "baseline")
        
        Returns:
            日志记录列表
        """
        problem_dir = self._get_problem_data_dir(problem_id)
        log_file = problem_dir / f"{data_type}_logs.json"
        
        cache_key = f"{problem_id}_{data_type}_logs"
        if cache_key in self._data_cache:
            return self._data_cache[cache_key]
        
        data = self._load_json_file(log_file)
        if data is None:
            data = []
        
        self._data_cache[cache_key] = data
        
        if self.debug:
            self.logger.info(f"📂 加载 {problem_id} {data_type} 日志: {len(data)} 条记录")
        
        return data
    
    def load_metrics(self, problem_id: str, data_type: str = "failure") -> Dict[str, Any]:
        """加载指标数据
        
        Args:
            problem_id: 问题ID
            data_type: 数据类型 ("failure" 或 "baseline")
            
        Returns:
            包含k8s_metrics和apm_metrics的字典
        """
        problem_dir = self._get_problem_data_dir(problem_id)
        metric_file = problem_dir / f"{data_type}_metrics.json"
        
        cache_key = f"{problem_id}_{data_type}_metrics"
        if cache_key in self._data_cache:
            return self._data_cache[cache_key]
        
        data = self._load_json_file(metric_file)
        if data is None:
            data = {
                "k8s_metrics": {},
                "apm_metrics": {},
                "analysis_result": {}
            }
        
        self._data_cache[cache_key] = data
        
        if self.debug:
            k8s_count = len(data.get("k8s_metrics", {}))
            apm_count = len(data.get("apm_metrics", {}))
            self.logger.info(f"📈 加载 {problem_id} {data_type} 指标: K8s={k8s_count}, APM={apm_count}")
        
        return data
    
    def load_traces(self, problem_id: str, data_type: str = "failure") -> List[Dict[str, Any]]:
        """加载链路数据
        
        Args:
            problem_id: 问题ID
            data_type: 数据类型 ("failure" 或 "baseline")
            
        Returns:
            链路跟踪数据列表
        """
        problem_dir = self._get_problem_data_dir(problem_id)
        trace_file = problem_dir / f"{data_type}_traces.json"
        
        cache_key = f"{problem_id}_{data_type}_traces"
        if cache_key in self._data_cache:
            return self._data_cache[cache_key]
        
        data = self._load_json_file(trace_file)
        if data is None:
            data = []
        
        self._data_cache[cache_key] = data
        
        if self.debug:
            self.logger.info(f"🔗 加载 {problem_id} {data_type} 链路: {len(data)} 条记录")
        
        return data
    
    def check_data_availability(self, problem_id: str) -> Dict[str, bool]:
        """检查问题数据的可用性
        
        Returns:
            每种数据类型的可用性状态
        """
        problem_dir = self._get_problem_data_dir(problem_id)
        
        if not problem_dir.exists():
            return {file_type: False for file_type in [
                'failure_logs', 'failure_metrics', 'failure_traces',
                'baseline_logs', 'baseline_metrics'
            ]}
        
        availability = {}
        for file_type in ['failure_logs', 'failure_metrics', 'failure_traces',
                         'baseline_logs', 'baseline_metrics']:
            file_path = problem_dir / f"{file_type}.json"
            availability[file_type] = file_path.exists()
        
        return availability
    
    def get_available_problems(self) -> List[str]:
        """获取所有可用的问题ID列表"""
        available_problems = []
        
        for problem_dir in self.data_dir.iterdir():
            if problem_dir.is_dir() and problem_dir.name.startswith("problem_"):
                problem_id = problem_dir.name.replace("problem_", "")
                # 检查是否有基本的数据文件
                if (problem_dir / "failure_logs.json").exists():
                    available_problems.append(problem_id)
        
        return sorted(available_problems)
    
    def get_data_summary(self, problem_id: str) -> Dict[str, Any]:
        """获取问题数据的详细摘要"""
        
        availability = self.check_data_availability(problem_id)
        metadata = self.get_problem_metadata(problem_id)
        
        summary = {
            "problem_id": problem_id,
            "data_availability": availability,
            "metadata": metadata,
            "total_files": sum(availability.values()),
            "missing_files": [k for k, v in availability.items() if not v]
        }
        
        # 如果有元数据，添加更多信息
        if metadata:
            summary["download_info"] = {
                "download_timestamp": metadata.get("download_timestamp"),
                "success_count": metadata.get("success_count", 0),
                "total_tasks": metadata.get("total_tasks", 5),
                "success_rate": metadata.get("success_count", 0) / metadata.get("total_tasks", 5)
            }
        
        return summary
    
    def clear_cache(self):
        """清空数据缓存"""
        self._data_cache.clear()
        self.logger.info("🗑️  数据缓存已清空")

# 按目录缓存实例，避免不同离线路径相互污染
_local_data_loader_instances: Dict[str, LocalDataLoader] = {}

def get_local_data_loader(data_dir: Optional[str] = None, debug: bool = False) -> LocalDataLoader:
    """获取本地数据加载器单例"""
    key = str(Path(data_dir).expanduser().resolve()) if data_dir else "__default__"
    if key not in _local_data_loader_instances:
        _local_data_loader_instances[key] = LocalDataLoader(data_dir=data_dir, debug=debug)
    return _local_data_loader_instances[key]
