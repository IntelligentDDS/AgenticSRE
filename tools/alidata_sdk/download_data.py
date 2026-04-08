#!/usr/bin/env python
"""
数据下载脚本
用于批量下载A榜所有问题的观测数据到本地，支持本地模式分析
"""

import asyncio
import json
import os
import sys
import time
import argparse
from datetime import datetime
from typing import List, Dict, Any, Optional
import logging
from pathlib import Path

# 添加项目路径
project_root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project_root))

from tools.alidata_sdk.agents.log_agent import MinimalLogAgent
from tools.alidata_sdk.agents.metric_agent import MinimalMetricAgent
from tools.alidata_sdk.agents.trace_agent import MinimalTraceAgent
from tools.alidata_sdk.utils.evidence_chain import EvidenceChain

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

class DataDownloader:
    """观测数据下载器"""
    
    def __init__(
        self,
        force_refresh: bool = False,
        debug: bool = False,
        offline_mode: bool = False,
        data_dir: str = "",
        problem_id: str = "",
        data_type: str = "auto",
    ):
        self.force_refresh = force_refresh
        self.debug = debug
        self.offline_mode = offline_mode
        self.problem_id = str(problem_id or "").strip()
        self.offline_data_type = (data_type or "auto").strip().lower()
        self.logger = logging.getLogger(__name__)
        
        # 数据存储目录
        self.data_dir = Path(data_dir).expanduser().resolve() if data_dir else (project_root / "data")
        if not self.offline_mode:
            self.data_dir.mkdir(exist_ok=True)
        self.local_loader = None
        
        # 初始化agents
        try:
            if self.offline_mode:
                from tools.alidata_sdk.utils.local_data_loader import get_local_data_loader

                self.local_loader = get_local_data_loader(
                    data_dir=str(self.data_dir),
                    debug=debug,
                )
                self.log_agent = MinimalLogAgent(
                    debug=debug,
                    offline_mode=True,
                    problem_id=self.problem_id,
                    data_dir=str(self.data_dir),
                )
                self.metric_agent = MinimalMetricAgent(
                    debug=debug,
                    offline_mode=True,
                    problem_id=self.problem_id,
                    data_dir=str(self.data_dir),
                )
                self.trace_agent = MinimalTraceAgent(
                    debug=debug,
                    offline_mode=True,
                    problem_id=self.problem_id,
                    data_dir=str(self.data_dir),
                )
                self.logger.info(
                    "✅ 离线模式初始化完成: data_dir=%s, problem_id=%s, data_type=%s",
                    self.data_dir,
                    self.problem_id or "(unset)",
                    self.offline_data_type,
                )
            else:
                self.log_agent = MinimalLogAgent(debug=debug)
                self.metric_agent = MinimalMetricAgent(debug=debug)
                self.trace_agent = MinimalTraceAgent(debug=debug)
                self.logger.info("✅ 三个agents初始化完成")
        except Exception as e:
            self.logger.error(f"❌ Agents初始化失败: {e}")
            raise

    def _resolve_offline_data_type(self, start_time: datetime, end_time: datetime) -> str:
        """Resolve baseline/failure selection for offline mode."""
        if self.offline_data_type in {"baseline", "failure"}:
            return self.offline_data_type

        duration_minutes = (end_time - start_time).total_seconds() / 60
        return "failure" if duration_minutes <= 10 else "baseline"

    def _ensure_offline_ready(self) -> str:
        """Validate offline config and return the target problem id."""
        if not self.offline_mode:
            raise RuntimeError("Offline mode is not enabled")
        if not self.problem_id:
            raise ValueError("offline_problem_id is required when offline_mode=true")
        if self.local_loader is None:
            raise ValueError("LocalDataLoader is not initialized")
        return self.problem_id
    
    def _parse_time_range(self, time_range: str) -> tuple:
        """解析时间范围字符串"""
        try:
            start_str, end_str = time_range.split(' ~ ')
            start_time = datetime.strptime(start_str, '%Y-%m-%d %H:%M:%S')
            end_time = datetime.strptime(end_str, '%Y-%m-%d %H:%M:%S')
            return start_time, end_time
        except Exception as e:
            self.logger.error(f"❌ 时间范围解析失败: {e}")
            raise ValueError(f"Invalid time range format: {time_range}")
    
    def _calculate_baseline_period(self, failure_start: datetime) -> tuple:
        """计算基线期时间范围（与parallel_data_coordinator保持一致）"""
        from datetime import timedelta
        
        # 配置参数（与aiops_engine保持一致）
        baseline_hours_before = 0.15  # 9分钟
        baseline_buffer_minutes = 1   # 1分钟缓冲（用户修改后的值）
        
        # 故障前1分钟作为基线结束时间
        baseline_end = failure_start - timedelta(minutes=baseline_buffer_minutes)
        
        # 从基线结束时间往前推9分钟作为基线窗口
        baseline_start = baseline_end - timedelta(hours=baseline_hours_before)
        
        return baseline_start, baseline_end
    
    def _check_existing_data(self, problem_id: str) -> Dict[str, bool]:
        """检查问题的本地数据是否已存在"""
        problem_dir = self.data_dir / f"problem_{problem_id}"
        
        required_files = [
            'failure_logs.json',
            'failure_metrics.json', 
            'failure_traces.json',
            'baseline_logs.json',
            'baseline_metrics.json'
        ]
        
        existence_status = {}
        for file_name in required_files:
            file_path = problem_dir / file_name
            existence_status[file_name] = file_path.exists()
        
        return existence_status
    
    async def _download_single_problem_data(self, problem_data: Dict[str, Any]) -> bool:
        """下载单个问题的所有观测数据"""
        
        problem_id = problem_data['problem_id']
        time_range = problem_data['time_range']
        
        self.logger.info(f"\n🎯 开始下载问题 {problem_id} 的观测数据")
        self.logger.info(f"   时间范围: {time_range}")
        
        # 创建问题目录
        problem_dir = self.data_dir / f"problem_{problem_id}"
        problem_dir.mkdir(exist_ok=True)
        
        # 检查现有数据
        existing_data = self._check_existing_data(problem_id)
        if not self.force_refresh and all(existing_data.values()):
            self.logger.info(f"   ✅ 问题 {problem_id} 的数据已存在，跳过下载")
            return True
        
        try:
            # 解析时间范围
            start_time, end_time = self._parse_time_range(time_range)
            baseline_start, baseline_end = self._calculate_baseline_period(start_time)
            
            self.logger.info(f"   📅 故障时间: {start_time} ~ {end_time}")
            self.logger.info(f"   📅 基线时间: {baseline_start} ~ {baseline_end}")
            
            # 下载任务定义
            download_tasks = [
                ('failure_logs', 'log', start_time, end_time),
                ('failure_metrics', 'metric', start_time, end_time), 
                ('failure_traces', 'trace', start_time, end_time),
                ('baseline_logs', 'log', baseline_start, baseline_end),
                ('baseline_metrics', 'metric', baseline_start, baseline_end),
            ]
            
            success_count = 0
            total_tasks = len(download_tasks)
            
            # 串行下载各类数据（避免服务压力过大）
            for task_name, agent_type, task_start, task_end in download_tasks:
                file_path = problem_dir / f"{task_name}.json"
                
                # 如果文件已存在且不强制刷新，跳过
                if not self.force_refresh and file_path.exists():
                    self.logger.info(f"   ✅ {task_name} 已存在，跳过")
                    success_count += 1
                    continue
                
                self.logger.info(f"   🔄 下载 {task_name}...")
                
                try:
                    # 根据agent类型下载数据
                    if agent_type == 'log':
                        data = await self._download_log_data(task_start, task_end)
                    elif agent_type == 'metric':
                        data = await self._download_metric_data(task_start, task_end)
                    elif agent_type == 'trace':
                        data = await self._download_trace_data(task_start, task_end)
                    else:
                        self.logger.error(f"   ❌ 未知的agent类型: {agent_type}")
                        continue
                    
                    # 保存数据到文件
                    with open(file_path, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2, default=str)
                    
                    data_size = len(data) if isinstance(data, list) else len(str(data))
                    self.logger.info(f"   ✅ {task_name} 下载完成 ({data_size} 项)")
                    success_count += 1
                    
                    # 添加延迟避免服务压力
                    await asyncio.sleep(0.5)
                    
                except Exception as e:
                    self.logger.error(f"   ❌ {task_name} 下载失败: {e}")
                    # 创建空文件标记尝试过
                    with open(file_path, 'w', encoding='utf-8') as f:
                        json.dump({"error": str(e), "timestamp": datetime.now().isoformat()}, f)
            
            # 创建元数据文件
            metadata = {
                "problem_id": problem_id,
                "time_range": time_range,
                "download_timestamp": datetime.now().isoformat(),
                "success_count": success_count,
                "total_tasks": total_tasks,
                "baseline_time_range": f"{baseline_start} ~ {baseline_end}",
                "force_refresh": self.force_refresh
            }
            
            metadata_path = problem_dir / "metadata.json"
            with open(metadata_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, ensure_ascii=False, indent=2)
            
            success_rate = success_count / total_tasks
            if success_rate >= 0.6:  # 60%以上任务成功认为问题数据下载成功
                self.logger.info(f"   🎉 问题 {problem_id} 下载完成 ({success_count}/{total_tasks} 成功)")
                return True
            else:
                self.logger.warning(f"   ⚠️ 问题 {problem_id} 下载部分失败 ({success_count}/{total_tasks} 成功)")
                return False
                
        except Exception as e:
            self.logger.error(f"   ❌ 问题 {problem_id} 下载失败: {e}")
            return False
    
    async def _download_log_data(self, start_time: datetime, end_time: datetime) -> List[Dict[str, Any]]:
        """下载日志数据"""
        if self.offline_mode:
            problem_id = self._ensure_offline_ready()
            data_type = self._resolve_offline_data_type(start_time, end_time)
            self.logger.info("📂 离线读取日志: problem_%s/%s_logs.json", problem_id, data_type)
            return self.local_loader.load_logs(problem_id, data_type)

        evidence_chain = EvidenceChain(start_time, end_time)
        result = self.log_agent.analyze(evidence_chain)
        
        # 从evidence_chain中提取原始日志数据
        log_data = []
        for evidence in evidence_chain.evidence:
            if evidence.evidence_type == 'log' and isinstance(evidence.data, list):
                log_data.extend(evidence.data)
        
        return log_data
    
    async def _download_metric_data(self, start_time: datetime, end_time: datetime) -> Dict[str, Any]:
        """下载指标数据"""
        if self.offline_mode:
            problem_id = self._ensure_offline_ready()
            data_type = self._resolve_offline_data_type(start_time, end_time)
            self.logger.info("📂 离线读取指标: problem_%s/%s_metrics.json", problem_id, data_type)
            metric_data = self.local_loader.load_metrics(problem_id, data_type)
            return {
                "k8s_metrics": metric_data.get("k8s_metrics", {}),
                "apm_metrics": metric_data.get("apm_metrics", {}),
                "analysis_result": metric_data.get("analysis_result", {}),
            }

        evidence_chain = EvidenceChain(start_time, end_time)
        result = self.metric_agent.analyze(evidence_chain)
        
        # 从evidence_chain中提取原始指标数据
        metric_data = {
            "k8s_metrics": {},
            "apm_metrics": {},
            "analysis_result": result
        }
        
        # 🔧 修复：MetricAgent将所有数据存储在单个evidence中，结构为all_metrics
        for evidence in evidence_chain.evidence:
            if evidence.evidence_type == 'metric':
                if isinstance(evidence.data, dict):
                    # evidence.data的结构: {'k8s_golden_metrics': {...}, 'apm_service_metrics': {...}}
                    k8s_data = evidence.data.get('k8s_golden_metrics', {})
                    apm_data = evidence.data.get('apm_service_metrics', {})
                    
                    # 检查K8s数据结构：新结构是 {pod_name: {metric_name: {...}}}
                    if k8s_data and isinstance(list(k8s_data.values())[0], dict):
                        # 新的按Pod组织的结构
                        metric_data["k8s_metrics"] = k8s_data
                        
                        # 统计信息
                        total_pods = len(k8s_data)
                        total_metrics = sum(len(pod_data) for pod_data in k8s_data.values())
                        self.logger.info(f"✅ 提取到 K8s指标: {total_pods}个Pod, {total_metrics}个指标类型")
                        
                    else:
                        # 旧的混合结构（向后兼容）
                        metric_data["k8s_metrics"].update(k8s_data)
                        self.logger.info(f"✅ 提取到 K8s指标: {len(k8s_data)} 个（旧格式）")
                    
                    self.logger.info(f"🏢 涉及服务: {sorted(apm_data.keys())}")                    
                    # APM数据结构保持不变
                    metric_data["apm_metrics"].update(apm_data)
                    break  # MetricAgent只添加一个metric evidence
        
        return metric_data
    
    async def _download_trace_data(self, start_time: datetime, end_time: datetime) -> List[Dict[str, Any]]:
        """下载链路数据"""
        if self.offline_mode:
            problem_id = self._ensure_offline_ready()
            data_type = self._resolve_offline_data_type(start_time, end_time)
            self.logger.info("📂 离线读取链路: problem_%s/%s_traces.json", problem_id, data_type)
            return self.local_loader.load_traces(problem_id, data_type)

        evidence_chain = EvidenceChain(start_time, end_time)
        result = self.trace_agent.analyze(evidence_chain)
        
        # 从evidence_chain中提取原始链路数据
        trace_data = []
        for evidence in evidence_chain.evidence:
            if evidence.evidence_type == 'trace' and isinstance(evidence.data, list):
                trace_data.extend(evidence.data)
        
        return trace_data

    async def download_all_problems(self, problems_file: str) -> None:
        """下载所有问题的观测数据"""
        
        self.logger.info("🚀 开始批量下载A榜观测数据")
        self.logger.info(f"   数据存储目录: {self.data_dir}")
        self.logger.info(f"   强制刷新: {self.force_refresh}")
        
        # 读取问题列表
        try:
            with open(problems_file, 'r', encoding='utf-8') as f:
                problems = []
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if line:
                        try:
                            problems.append(json.loads(line))
                        except json.JSONDecodeError as e:
                            self.logger.error(f"❌ 第{line_num}行JSON解析失败: {e}")
                            
            self.logger.info(f"   📋 加载了 {len(problems)} 个问题")
            
        except Exception as e:
            self.logger.error(f"❌ 读取问题文件失败: {e}")
            return
        
        # 开始下载
        start_time = time.time()
        successful_downloads = 0
        failed_problems = []
        
        for i, problem in enumerate(problems, 1):
            problem_id = problem.get('problem_id', f'unknown_{i}')
            
            self.logger.info(f"\n📍 处理问题 {i}/{len(problems)}: {problem_id}")
            
            try:
                success = await self._download_single_problem_data(problem)
                if success:
                    successful_downloads += 1
                else:
                    failed_problems.append(problem_id)
                    
            except Exception as e:
                self.logger.error(f"❌ 问题 {problem_id} 下载异常: {e}")
                failed_problems.append(problem_id)
        
        # 下载总结
        total_time = time.time() - start_time
        success_rate = successful_downloads / len(problems) if problems else 0
        
        self.logger.info(f"\n🎉 批量下载完成！")
        self.logger.info(f"   ✅ 成功下载: {successful_downloads}/{len(problems)} ({success_rate:.1%})")
        self.logger.info(f"   ⏱️  总耗时: {total_time:.1f}秒")
        self.logger.info(f"   💾 数据存储在: {self.data_dir}")
        
        if failed_problems:
            self.logger.warning(f"   ⚠️ 失败的问题: {failed_problems}")
        
        # 创建下载报告
        report = {
            "download_timestamp": datetime.now().isoformat(),
            "total_problems": len(problems),
            "successful_downloads": successful_downloads,
            "failed_problems": failed_problems,
            "success_rate": success_rate,
            "total_time_seconds": total_time,
            "force_refresh": self.force_refresh,
            "data_directory": str(self.data_dir)
        }
        
        report_path = self.data_dir / f"download_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_path, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        
        self.logger.info(f"   📊 下载报告: {report_path}")

    async def download_single_problem(self, problems_file: str, problem_id: str) -> None:
        """下载单个问题的观测数据"""
        
        self.logger.info(f"🎯 开始下载单个问题: {problem_id}")
        
        # 读取问题列表
        try:
            with open(problems_file, 'r', encoding='utf-8') as f:
                problems = []
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if line:
                        try:
                            problem_data = json.loads(line)
                            if problem_data.get('problem_id') == problem_id:
                                problems.append(problem_data)
                                break
                        except json.JSONDecodeError as e:
                            self.logger.error(f"❌ 第{line_num}行JSON解析失败: {e}")
                            
            if not problems:
                self.logger.error(f"❌ 未找到问题ID: {problem_id}")
                return
                
            self.logger.info(f"   ✅ 找到问题: {problem_id}")
            
        except Exception as e:
            self.logger.error(f"❌ 读取问题文件失败: {e}")
            return
        
        # 下载单个问题
        start_time = time.time()
        problem = problems[0]
        
        try:
            success = await self._download_single_problem_data(problem)
            total_time = time.time() - start_time
            
            if success:
                self.logger.info(f"🎉 问题 {problem_id} 下载完成！")
                self.logger.info(f"   ⏱️  耗时: {total_time:.1f}秒")
                self.logger.info(f"   💾 数据存储在: {self.data_dir}/problem_{problem_id}")
            else:
                self.logger.error(f"❌ 问题 {problem_id} 下载失败")
                
        except Exception as e:
            self.logger.error(f"❌ 问题 {problem_id} 下载异常: {e}")

    async def list_available_problems(self, problems_file: str) -> None:
        """列出所有可用的问题ID"""
        
        self.logger.info("📋 列出所有可用问题:")
        
        try:
            with open(problems_file, 'r', encoding='utf-8') as f:
                problems = []
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if line:
                        try:
                            problem_data = json.loads(line)
                            problems.append(problem_data)
                        except json.JSONDecodeError as e:
                            self.logger.error(f"❌ 第{line_num}行JSON解析失败: {e}")
                            
            self.logger.info(f"   📊 总共 {len(problems)} 个问题")
            
            for i, problem in enumerate(problems, 1):
                problem_id = problem.get('problem_id', f'unknown_{i}')
                time_range = problem.get('time_range', 'Unknown')
                
                # 检查本地数据状态
                existing_data = self._check_existing_data(problem_id)
                status = "✅ 已下载" if all(existing_data.values()) else "❌ 未下载"
                
                print(f"   {i:2d}. {problem_id} - {time_range} [{status}]")
                
        except Exception as e:
            self.logger.error(f"❌ 读取问题文件失败: {e}")

async def main():
    parser = argparse.ArgumentParser(description='下载A榜所有问题的观测数据到本地')
    parser.add_argument('--problems-file', default='dataset/B榜题目.jsonl',
                       help='问题文件路径 (默认: dataset/B榜题目.jsonl)')
    parser.add_argument('--force-refresh', action='store_true',
                       help='强制重新下载已存在的数据')
    parser.add_argument('--debug', action='store_true',
                       help='启用调试模式')
    parser.add_argument('--single-problem', type=str,
                       help='只下载指定问题ID的数据 (例如: 004)')
    parser.add_argument('--list-problems', action='store_true',
                       help='列出所有可用的问题ID')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.problems_file):
        print(f"❌ 问题文件不存在: {args.problems_file}")
        sys.exit(1)
    
    downloader = DataDownloader(
        force_refresh=args.force_refresh,
        debug=args.debug
    )
    
    # 处理单个问题下载
    if args.single_problem:
        await downloader.download_single_problem(args.problems_file, args.single_problem)
    elif args.list_problems:
        await downloader.list_available_problems(args.problems_file)
    else:
        await downloader.download_all_problems(args.problems_file)

if __name__ == "__main__":
    asyncio.run(main())
