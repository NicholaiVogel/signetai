#!/bin/sh
set -eu

root="${SIGNET_PATH:-/data/agents}"
cfg="$root/agent.yaml"

if [ ! -f "$cfg" ]; then
	mkdir -p "$root"
	cat > "$cfg" <<'YAML'
auth:
  mode: team
YAML
	printf '%s\n' "[docker] wrote default auth.mode=team to $cfg"
fi

# A fresh Docker volume is initialized by this entrypoint. Seed an empty,
# valid SQLite container so the daemon preflight can distinguish it from an
# established workspace whose database disappeared.
db="$root/memory/memories.db"
if [ ! -f "$db" ]; then
	mkdir -p "$(dirname "$db")"
	bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); db.close();' "$db"
	printf '%s\n' "[docker] initialized workspace database at $db"
fi


# seed default workspace scripts/skills for fresh volumes
tpl="/app/dist/signetai/templates"

if [ -d "$tpl/scripts" ] && [ ! -d "$root/scripts" ]; then
	mkdir -p "$root/scripts"
	cp -R "$tpl/scripts/." "$root/scripts/"
fi

if [ -d "$tpl/skills" ] && [ ! -d "$root/skills" ]; then
	mkdir -p "$root/skills"
	cp -R "$tpl/skills/." "$root/skills/"
fi

exec /app/bin/signet
