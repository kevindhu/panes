import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseMessageCreatedAtTimestamp } from "../../lib/messageTimestamp";

function formatTimeAgo(timestamp: number, now: number, locale: string, justNow: string): string {
  const elapsed = Math.max(0, now - timestamp);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 24 * 60 * 60_000],
    ["month", 30 * 24 * 60 * 60_000],
    ["week", 7 * 24 * 60 * 60_000],
    ["day", 24 * 60 * 60_000],
    ["hour", 60 * 60_000],
    ["minute", 60_000],
  ];
  const unit = units.find(([, duration]) => elapsed >= duration);
  return unit
    ? new Intl.RelativeTimeFormat(locale).format(-Math.floor(elapsed / unit[1]), unit[0])
    : justNow;
}

export function MessageTimestamp({ createdAt }: { createdAt: string }) {
  const { t, i18n } = useTranslation("chat");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [now, setNow] = useState(Date.now());
  const [showExactTime, setShowExactTime] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const timestamp = parseMessageCreatedAtTimestamp(createdAt);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  const exactTime = date.toLocaleString(locale, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
  return (
    <button
      className="codex-message-timestamp"
      type="button"
      title={exactTime}
      aria-label={t("turnTimestamp.toggle", { date: exactTime })}
      aria-pressed={showExactTime}
      onClick={() => setShowExactTime((current) => !current)}
    >
      <time dateTime={date.toISOString()}>
        {showExactTime ? exactTime : formatTimeAgo(timestamp, now, locale, t("turnTimestamp.justNow"))}
      </time>
    </button>
  );
}
