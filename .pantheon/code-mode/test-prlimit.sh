#!/bin/bash
# ---
# timeout: 5
# ---
echo "pid: $$"
cat /proc/self/limits | grep -E "Max cpu|Max address|Max processes" 2>&1 | head -n 5
echo "--- prlimit in cmd check ---"
# Show that prlimit limits are applied: prlimit --cpu=10 should show cpu 10
prlimit --output RESOURCE,SOFT,HARD 2>&1 | head -n 20
