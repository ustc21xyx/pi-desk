#!/bin/sh
# Trusted helper copied out of the app before it quits. All paths are supplied by the main process.
set -eu
parent_pid=$1
stage=$2
target=$3
workspace=$4
backup="${stage%.app}-previous.app"
result="$workspace/result.txt"
case "$parent_pid" in ''|*[!0-9]*) exit 1 ;; esac
case "$stage" in "${target%/*}/.Pi Desk-update-"*.app) ;; *) exit 1 ;; esac
exec > "$workspace/install.log" 2>&1
moved_old=0
installed=0
success=0
cleanup() {
  if [ "$success" = 1 ]; then return; fi
  printf '%s\n' '安装未完成，已保留或恢复旧版。' > "$result"
  if [ "$moved_old" = 1 ]; then
    if [ "$installed" = 1 ]; then /bin/mv "$target" "$stage" || return; fi
    /bin/mv "$backup" "$target" || return
    /usr/bin/open -a "$target" || true
  fi
  if [ -d "$stage" ]; then /bin/rm -rf "$stage"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '%s\n' 'ready' > "$workspace/helper-ready"

# Never terminate Pi or the app. Wait for normal shutdown, including Electron helpers.
attempt=0
while kill -0 "$parent_pid" 2>/dev/null || /bin/ps -axo comm= | /usr/bin/awk -v prefix="$target/Contents/" 'index($0,prefix)==1 {found=1} END {exit !found}'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 120 ]; then exit 1; fi
  /bin/sleep 1
done
/usr/bin/codesign --verify --deep --strict "$stage"
[ -d "$target" ] && [ ! -L "$target" ] && [ ! -e "$backup" ]
/bin/mv "$target" "$backup"
moved_old=1
/bin/mv "$stage" "$target"
installed=1
/usr/bin/codesign --verify --deep --strict "$target"
/usr/bin/open -a "$target"
success=1
printf '安装完成。旧版备份：%s\n' "$backup" > "$result"
# Keep the application backup; discard only this operation's downloaded image.
for download in "$workspace"/Pi-Desk-*.dmg; do
  if [ -f "$download" ]; then /bin/rm -f "$download"; fi
done
