#!/bin/sh
# Appends one line to ~/.brain-unrot/events.jsonl for the Brain Unrot VS Code extension:
#   {"event": "prompt" | "read" | "stop", "cwd": ..., "session_id": ..., "file": ..., "at": <ms>}
# The hook's JSON input arrives on stdin. It never blocks Claude: it prints nothing (a
# UserPromptSubmit hook's output would go into Claude's context), needs no jq, and always exits 0.
# Nothing is written for the claude processes the extension starts itself.

[ -n "$BRAIN_UNROT_CHILD" ] && exit 0

event="$1"
input=$(cat)

# The first "key": "value" string in the input. Values are copied as they are, still JSON-escaped,
# so they go back into JSON unchanged. For a Read, the first file_path is the one in tool_input
field() {
  printf '%s' "$input" | tr '\n' ' ' | grep -oE "\"$1\" *: *\"([^\"\\\\]|\\\\.)*\"" | head -n 1 | sed "s/^\"$1\" *: *\"//; s/\"\$//"
}

# A slash command isn't a prompt for Claude to work on
if [ "$event" = prompt ]; then
  case "$(field prompt)" in /*) exit 0 ;; esac
fi

cwd=$(field cwd)
[ -z "$cwd" ] && cwd=$(pwd)
session=$(field session_id)
file=""
if [ "$event" = read ]; then
  file=$(field file_path)
  [ -z "$file" ] && exit 0
fi

line="{\"event\":\"$event\",\"cwd\":\"$cwd\",\"session_id\":\"$session\""
[ -n "$file" ] && line="$line,\"file\":\"$file\""
line="$line,\"at\":$(date +%s)000}"

# BRAIN_UNROT_DIR is for tests
dir="${BRAIN_UNROT_DIR:-$HOME/.brain-unrot}"
mkdir -p "$dir" 2>/dev/null
printf '%s\n' "$line" >>"$dir/events.jsonl" 2>/dev/null
exit 0
