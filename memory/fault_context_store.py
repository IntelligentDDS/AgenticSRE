"""
AgenticSRE Fault Context Store
Persistent storage for diagnostic rules and fault contexts.
Supports ChromaDB (primary) and JSON fallback.
WeRCA-style continuous fault context learning.
"""

import json
import hashlib
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class FaultContextStore:
    """
    Persistent storage for:
    - Diagnostic rules: "If condition, then conclusion" patterns
    - Fault contexts: Historical fault records with full evidence
    
    Primary: ChromaDB with cosine similarity
    Fallback: JSON files with simple TF-IDF matching
    """

    def __init__(self, config=None):
        from configs.config_loader import get_config
        cfg = config or get_config()
        self.mem_cfg = cfg.memory
        self.db_path = Path(self.mem_cfg.db_path)
        self.db_path.mkdir(parents=True, exist_ok=True)
        
        self._backend = None
        self._init_backend()

    def _init_backend(self):
        """Initialize ChromaDB or fallback to JSON."""
        if self.mem_cfg.backend == "chromadb":
            try:
                import chromadb
                self._client = chromadb.PersistentClient(path=str(self.db_path / "chromadb"))
                self._rules_col = self._client.get_or_create_collection(
                    name=self.mem_cfg.rules_collection,
                    metadata={"hnsw:space": "cosine"},
                )
                self._faults_col = self._client.get_or_create_collection(
                    name=self.mem_cfg.faults_collection,
                    metadata={"hnsw:space": "cosine"},
                )
                self._backend = "chromadb"
                logger.info("FaultContextStore: using ChromaDB backend")
            except Exception as e:
                logger.warning(f"ChromaDB init failed: {e}, falling back to JSON")
                self._backend = "json"
        else:
            self._backend = "json"
        
        if self._backend == "json":
            self._rules_file = self.db_path / "rules.json"
            self._faults_file = self.db_path / "faults.json"
            self._load_json()

    def _load_json(self):
        """Load JSON fallback data."""
        self._rules_data = []
        self._faults_data = []
        if self._rules_file.exists():
            try:
                self._rules_data = json.loads(self._rules_file.read_text())
            except Exception:
                pass
        if self._faults_file.exists():
            try:
                self._faults_data = json.loads(self._faults_file.read_text())
            except Exception:
                pass

    def _save_json(self):
        """Save JSON fallback data."""
        self._rules_file.write_text(json.dumps(self._rules_data, indent=2, ensure_ascii=False))
        self._faults_file.write_text(json.dumps(self._faults_data, indent=2, ensure_ascii=False))

    # ── Rule Operations ──

    def add_rule(self, rule: Dict) -> str:
        """Add a diagnostic rule. Returns rule_id."""
        rule_id = f"rule-{hashlib.md5(json.dumps(rule, sort_keys=True).encode()).hexdigest()[:10]}"
        rule["rule_id"] = rule_id
        rule["timestamp"] = time.time()
        
        if self._backend == "chromadb":
            text = f"{rule.get('condition', '')} -> {rule.get('conclusion', '')}"
            self._rules_col.upsert(
                ids=[rule_id],
                documents=[text],
                metadatas=[{k: str(v) for k, v in rule.items() if isinstance(v, (str, int, float, bool))}],
            )
        else:
            # Check for duplicates
            if not any(r.get("rule_id") == rule_id for r in self._rules_data):
                self._rules_data.append(rule)
                self._save_json()
        
        logger.info(f"Added rule: {rule_id}")
        return rule_id

    def query_similar_rules(self, query: str, n: int = 5) -> List[Dict]:
        """Find rules similar to the query."""
        if self._backend == "chromadb":
            try:
                results = self._rules_col.query(query_texts=[query], n_results=min(n, 10))
                rules = []
                for i, doc in enumerate(results.get("documents", [[]])[0]):
                    meta = results.get("metadatas", [[]])[0][i] if results.get("metadatas") else {}
                    distance = results.get("distances", [[]])[0][i] if results.get("distances") else 0
                    rules.append({**meta, "text": doc, "similarity": 1 - distance})
                return rules
            except Exception as e:
                logger.error(f"ChromaDB query failed: {e}")
                return []
        else:
            # Simple keyword matching fallback
            query_lower = query.lower()
            scored = []
            for rule in self._rules_data:
                text = f"{rule.get('condition', '')} {rule.get('conclusion', '')}".lower()
                # Simple overlap score
                query_words = set(query_lower.split())
                text_words = set(text.split())
                overlap = len(query_words & text_words)
                if overlap > 0:
                    scored.append((rule, overlap / max(len(query_words), 1)))
            scored.sort(key=lambda x: x[1], reverse=True)
            return [r for r, _ in scored[:n]]

    # ── Fault Context Operations ──

    def add_fault(self, fault: Dict) -> str:
        """Add a historical fault context. Returns fault_id."""
        fault_id = f"fault-{hashlib.md5(json.dumps(fault, sort_keys=True, default=str).encode()).hexdigest()[:10]}"
        fault["fault_id"] = fault_id
        fault["timestamp"] = time.time()
        
        if self._backend == "chromadb":
            text = f"{fault.get('description', '')} {fault.get('root_cause', '')} {fault.get('fault_type', '')}"
            self._faults_col.upsert(
                ids=[fault_id],
                documents=[text],
                metadatas=[{k: str(v)[:500] for k, v in fault.items() 
                           if isinstance(v, (str, int, float, bool))}],
            )
        else:
            if not any(f.get("fault_id") == fault_id for f in self._faults_data):
                self._faults_data.append(fault)
                self._save_json()
        
        logger.info(f"Added fault context: {fault_id}")
        return fault_id

    def query_similar_faults(self, query: str, n: int = 5) -> List[Dict]:
        """Find fault contexts similar to the query."""
        if self._backend == "chromadb":
            try:
                results = self._faults_col.query(query_texts=[query], n_results=min(n, 10))
                faults = []
                for i, doc in enumerate(results.get("documents", [[]])[0]):
                    meta = results.get("metadatas", [[]])[0][i] if results.get("metadatas") else {}
                    faults.append({**meta, "text": doc})
                return faults
            except Exception as e:
                logger.error(f"ChromaDB fault query failed: {e}")
                return []
        else:
            query_lower = query.lower()
            scored = []
            for fault in self._faults_data:
                text = f"{fault.get('description', '')} {fault.get('root_cause', '')}".lower()
                query_words = set(query_lower.split())
                text_words = set(text.split())
                overlap = len(query_words & text_words)
                if overlap > 0:
                    scored.append((fault, overlap / max(len(query_words), 1)))
            scored.sort(key=lambda x: x[1], reverse=True)
            return [r for r, _ in scored[:n]]

    def get_historical_context(self, incident_query: str) -> Dict:
        """Get combined historical context for hypothesis generation."""
        similar_rules = self.query_similar_rules(incident_query, n=self.mem_cfg.max_similar_results)
        similar_faults = self.query_similar_faults(incident_query, n=self.mem_cfg.max_similar_results)
        
        return {
            "rules": similar_rules,
            "faults": similar_faults,
            "rules_count": len(similar_rules),
            "faults_count": len(similar_faults),
        }

    def stats(self) -> Dict:
        """Get store statistics."""
        if self._backend == "chromadb":
            return {
                "backend": "chromadb",
                "rules_count": self._rules_col.count(),
                "faults_count": self._faults_col.count(),
            }
        else:
            return {
                "backend": "json",
                "rules_count": len(self._rules_data),
                "faults_count": len(self._faults_data),
            }
