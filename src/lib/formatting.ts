import type { ValueMode } from "../data/types.ts";

const ETH_SYMBOL = "\u039E";

function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits === 0 ? 0 : Math.min(digits, 2),
  }).format(value);
}

export function formatValue(
  ethValue: number | undefined,
  usdValue: number | undefined,
  ethUsd: number,
  mode: ValueMode,
) {
  if (ethValue === undefined && usdValue === undefined) {
    return "N/A";
  }

  const resolvedEth = ethValue ?? (usdValue !== undefined ? usdValue / ethUsd : undefined);
  const resolvedUsd = usdValue ?? (ethValue !== undefined ? ethValue * ethUsd : undefined);

  const ethText = resolvedEth === undefined ? null : `${formatNumber(resolvedEth)} ${ETH_SYMBOL}`;
  const usdText =
    resolvedUsd === undefined ? null : `$${formatNumber(resolvedUsd, resolvedUsd > 999 ? 0 : 2)}`;

  switch (mode) {
    case "eth":
      return ethText ?? "N/A";
    case "usd":
      return usdText ?? "N/A";
    case "usd-eth":
      return [usdText, ethText].filter(Boolean).join(" / ");
    case "eth-usd":
      return [ethText, usdText].filter(Boolean).join(" / ");
    default:
      return ethText ?? usdText ?? "N/A";
  }
}

export function formatPercent(value: number | undefined, digits = 1) {
  if (value === undefined) {
    return "N/A";
  }
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value * (Math.abs(value) <= 1 ? 100 : 1))}%`;
}

export function formatDate(timestamp: number | undefined) {
  if (!timestamp) {
    return "N/A";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp * 1000));
}

export function formatCompactDate(timestamp: number | undefined) {
  if (!timestamp) {
    return "N/A";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp * 1000));
}

export function formatDistance(value: number | undefined) {
  if (value === undefined) {
    return "N/A";
  }
  return `${formatNumber(value, value >= 10 ? 1 : 2)} pts`;
}

export function formatRelativeAge(timestamp: number | undefined, referenceTimestamp: number) {
  if (!timestamp) {
    return "N/A";
  }

  const seconds = Math.max(referenceTimestamp - timestamp, 0);
  const day = 24 * 60 * 60;
  const month = 30 * day;
  const year = 365 * day;

  if (seconds < day) {
    return "< 1d ago";
  }
  if (seconds < month) {
    return `${Math.round(seconds / day)}d ago`;
  }
  if (seconds < year) {
    return `${Math.round(seconds / month)}m ago`;
  }
  return `${Math.round(seconds / year)}y ago`;
}

export function formatTokenNumber(tokenNumber: number) {
  return `#${tokenNumber}`;
}
