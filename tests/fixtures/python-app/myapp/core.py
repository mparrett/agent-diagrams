from __future__ import annotations

import json
from pathlib import Path

import yaml


def load_config(path: str) -> dict:
    text = Path(path).read_text()
    return yaml.safe_load(text) if path.endswith(".yaml") else json.loads(text)
