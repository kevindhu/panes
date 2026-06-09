type RelativeTimeStyle = "compact" | "short-with-suffix";

interface RelativeTimeOptions {
  style?: RelativeTimeStyle;
}

const APP_LOCALE = "en";

const COMPACT_LABELS = {
  now: "now",
  minute: "m",
  hour: "h",
  day: "d",
  month: "mo",
};

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCompactAmount(amount: number, unit: string): string {
  return `${amount}${unit}`;
}

export function formatRelativeTime(
  value: string | number | Date,
  _locale?: string | null,
  options: RelativeTimeOptions = {},
): string {
  const date = toDate(value);
  if (!date) {
    return "";
  }

  const diffMs = Date.now() - date.getTime();
  if (diffMs <= 45_000) {
    return COMPACT_LABELS.now;
  }

  const minutes = Math.max(1, Math.floor(diffMs / 60_000));
  if (minutes < 60) {
    const compact = formatCompactAmount(minutes, COMPACT_LABELS.minute);
    return options.style === "short-with-suffix" ? `${compact} ago` : compact;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const compact = formatCompactAmount(hours, COMPACT_LABELS.hour);
    return options.style === "short-with-suffix" ? `${compact} ago` : compact;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    const compact = formatCompactAmount(days, COMPACT_LABELS.day);
    return options.style === "short-with-suffix" ? `${compact} ago` : compact;
  }

  const months = Math.floor(days / 30);
  const compact = formatCompactAmount(months, COMPACT_LABELS.month);
  return options.style === "short-with-suffix" ? `${compact} ago` : compact;
}

export function formatShortDate(value: string | number | Date, _locale?: string | null): string {
  const date = toDate(value);
  if (!date) {
    return String(value);
  }

  return new Intl.DateTimeFormat(APP_LOCALE, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatDate(value: string | number | Date, _locale?: string | null): string {
  const date = toDate(value);
  if (!date) {
    return String(value);
  }

  return new Intl.DateTimeFormat(APP_LOCALE, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatDateTime(value: string | number | Date, _locale?: string | null): string {
  const date = toDate(value);
  if (!date) {
    return String(value);
  }

  return new Intl.DateTimeFormat(APP_LOCALE, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTime(value: string | number | Date, _locale?: string | null): string {
  const date = toDate(value);
  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat(APP_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
