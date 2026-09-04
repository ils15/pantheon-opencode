#!/usr/bin/env python3
"""Validate agent YAML frontmatter in CI."""
import os
import re
import sys

import yaml

errors = 0
for f in sorted(os.listdir('src/agents')):
    if not f.endswith('.md'):
        continue
    with open(f"src/agents/{f}", encoding="utf-8") as agent_file:
        content = agent_file.read()
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if match:
        try:
            yaml.safe_load(match.group(1))
        except yaml.YAMLError as e:
            print(f'FAIL: {f}: {e}')
            errors += 1

print(f'{sum(1 for _ in os.listdir("src/agents") if _.endswith(".md")) - errors}/{sum(1 for _ in os.listdir("src/agents") if _.endswith(".md"))} agents valid')
sys.exit(errors)
