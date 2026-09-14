#!/bin/sh
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
cd "$(dirname "$0")" || exit 1
node scripts/update.mjs
update_result=$?
printf '\n按回车关闭此窗口…'
read -r update_reply
exit "$update_result"
