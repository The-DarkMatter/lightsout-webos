#!/bin/sh
SVC=com.thedarkmatter.lightsout.service
DIR=/media/developer/apps/usr/palm/services/$SVC
RUN=/var/lib/webosbrew/lightsout-renew
LOG=/tmp/lightsout-renew.log
EVERY=21600
WARN_DAYS=14

if [ "$1" != "loop" ]; then
  mkdir -p "$RUN"
  [ -f "$RUN/pid" ] && kill "$(cat "$RUN/pid")" 2>/dev/null
  setsid sh "$0" loop >> "$LOG" 2>&1 < /dev/null &
  echo $! > "$RUN/pid"
  exit 0
fi

while [ -d "$DIR" ]; do
  out=$(luna-send-pub -n 1 -w 30000 "luna://$SVC/getAuthStatus" '{}' < /dev/null)
  days=$(echo "$out" | sed -n 's/.*"sessionDaysLeft":\([0-9.]*\).*/\1/p')
  pass=$(echo "$out" | sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p')
  echo "$(date) pass until ${pass:-none}, sign-in days left ${days:-?}"

  whole=${days%%.*}
  today=$(date +%Y-%m-%d)
  warned=$(cat "$RUN/warned" 2>/dev/null)
  if [ -n "$whole" ] && [ "$whole" -lt "$WARN_DAYS" ] && [ "$warned" != "$today" ]; then
    if [ "$whole" -le 0 ]; then
      msg="Lights Out: F1 TV sign-in has ended. Sign in again from the app."
    else
      msg="Lights Out: F1 TV sign-in ends in $whole days. Sign in again from the app to keep watching."
    fi
    luna-send -n 1 -a webosbrew luna://com.webos.notification/createToast \
      "{\"sourceId\":\"webosbrew\",\"message\":\"$msg\"}" < /dev/null > /dev/null
    echo "$today" > "$RUN/warned"
  fi

  sleep $EVERY
done
rm -f "$RUN/pid"
