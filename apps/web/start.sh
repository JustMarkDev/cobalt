#!/bin/sh
# Starts the production server. Bun's garbage collector sizes its heap from
# the machine's RAM, and in a container that is the host's, many times the
# container's limit, so the heap can grow until the container is killed. When
# the container has a memory limit (cgroup v2), tell the collector about it.
# It is read on every start, so it follows the limit as the service is resized.
limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
case "$limit" in
  '' | max) ;;
  *) [ -z "$BUN_JSC_forceRAMSize" ] && export BUN_JSC_forceRAMSize="$limit" ;;
esac
exec bun server.ts
