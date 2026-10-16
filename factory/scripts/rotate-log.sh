#!/usr/bin/env bash
# Rotates a log file that launchd keeps appending to. Usage: rotate-log.sh <file> [max_mb] [keep]
# (defaults 20 and 5). Does nothing, silently, when the file is missing or no bigger than max_mb.
# Over it, shifts <file>.1 .. <file>.<keep-1> up one place (.2 and older are gzipped), deletes
# anything numbered <keep> or higher, copies <file> to <file>.1 and truncates <file> in place.
#
# It copies and truncates rather than renaming because launchd holds the file open as the
# job's StandardOutPath and never reopens it. That is safe only because launchd opens it with
# O_APPEND: the writer's next write lands at the new end of the file, offset 0. Lines written
# between the copy and the truncate are lost; a few at most.
set -euo pipefail

file=${1:-}
max_mb=${2:-20}
keep=${3:-5}

if [[ -z $file || ! $max_mb =~ ^[0-9]+$ || ! $keep =~ ^[0-9]+$ || $keep -lt 1 ]]; then
  echo "usage: rotate-log.sh <file> [max_mb] [keep]  (max_mb and keep are integers, keep >= 1)" >&2
  exit 1
fi

[[ -f $file ]] || exit 0
size=$(($(wc -c < "$file")))
((size > max_mb * 1024 * 1024)) || exit 0

# Everything numbered keep or higher goes, including files left by an earlier larger keep.
shopt -s nullglob
for old in "$file".*; do
  n=${old#"$file".}
  n=${n%.gz}
  if [[ $n =~ ^[0-9]+$ ]] && ((n >= keep)); then rm -f "$old"; fi
done

for ((i = keep - 1; i >= 1; i--)); do
  if [[ -e $file.$i.gz ]]; then mv -f "$file.$i.gz" "$file.$((i + 1)).gz"; fi
  if [[ -e $file.$i ]]; then mv -f "$file.$i" "$file.$((i + 1))"; fi
done

cp "$file" "$file.1"
: > "$file"
if [[ -e $file.2 ]]; then gzip -f "$file.2"; fi

echo "rotated $file ($size bytes)"
