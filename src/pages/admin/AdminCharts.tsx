/*
 * Graphiques administrateur — SVG pur, sans dépendance externe.
 * Aucune donnée n'est inventée : les séries sont passées telles quelles et une
 * série vide affiche un état explicite au lieu d'un dessin décoratif.
 */
import { useId } from 'react';

export interface ChartSeries {
  label: string;
  color: string;
  values: number[];
}

function niceMax(values: number[]): number {
  const max = Math.max(0, ...values);
  if (max <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const scaled = max / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

export function BarChart({
  labels, values, color = '#38bdf8', height = 180, label, valueFormatter,
}: {
  labels: string[];
  values: number[];
  color?: string;
  height?: number;
  label: string;
  valueFormatter?: (value: number) => string;
}) {
  const max = niceMax(values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const width = Math.max(280, labels.length * 46);
  const barWidth = labels.length ? Math.min(34, (width - 24) / labels.length - 8) : 0;

  return (
    <figure className="w-full">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height + 26}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
      >
        <line x1={12} y1={height} x2={width - 8} y2={height} stroke="rgba(148,163,184,0.25)" strokeWidth="1" />
        {total === 0 && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fill="#64748b" fontSize="12">
            Aucune donnée sur la période
          </text>
        )}
        {values.map((value, index) => {
          const ratio = max > 0 ? value / max : 0;
          const barHeight = Math.max(total > 0 && value > 0 ? 2 : 0, ratio * (height - 16));
          const x = 16 + index * ((width - 24) / Math.max(1, labels.length));
          return (
            <g key={`${labels[index]}-${index}`}>
              <rect
                x={x}
                y={height - barHeight}
                width={barWidth}
                height={barHeight}
                rx={4}
                fill={color}
                opacity={value > 0 ? 0.85 : 0.2}
              >
                <title>{`${labels[index]} : ${valueFormatter ? valueFormatter(value) : value}`}</title>
              </rect>
              <text x={x + barWidth / 2} y={height + 16} textAnchor="middle" fill="#64748b" fontSize="10">
                {labels[index]?.slice(2) ?? ''}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-[11px] text-slate-500">
        {label} · total {valueFormatter ? valueFormatter(total) : total}
      </figcaption>
    </figure>
  );
}

export function LineChart({
  labels, series, height = 200, label, valueFormatter,
}: {
  labels: string[];
  series: ChartSeries[];
  height?: number;
  label: string;
  valueFormatter?: (value: number) => string;
}) {
  const width = Math.max(300, labels.length * 46);
  const all = series.flatMap((item) => item.values);
  const max = niceMax(all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const plotHeight = height - 24;
  const stepX = labels.length > 1 ? (width - 24) / (labels.length - 1) : 0;
  const y = (value: number) => 8 + plotHeight - ((value - min) / span) * plotHeight;
  const isEmpty = all.every((value) => value === 0);

  return (
    <figure className="w-full">
      <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height + 20}`} className="w-full" style={{ height }} preserveAspectRatio="none">
        <line x1={12} y1={y(0)} x2={width - 8} y2={y(0)} stroke="rgba(148,163,184,0.25)" strokeWidth="1" />
        {isEmpty && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fill="#64748b" fontSize="12">
            Aucune donnée sur la période
          </text>
        )}
        {series.map((item, seriesIndex) => {
          const points = item.values.map((value, index) => `${12 + index * stepX},${y(value)}`).join(' ');
          return (
            <g key={`${item.label}-${seriesIndex}`}>
              <polyline
                points={points}
                fill="none"
                stroke={item.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={isEmpty ? 0.25 : 1}
              />
              {item.values.map((value, index) => (
                <circle key={`${item.label}-${index}`} cx={12 + index * stepX} cy={y(value)} r={2.4} fill={item.color}>
                  <title>{`${labels[index]} · ${item.label} : ${valueFormatter ? valueFormatter(value) : value}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {labels.map((month, index) => (
          <text key={month} x={12 + index * stepX} y={height + 14} textAnchor="middle" fill="#64748b" fontSize="10">
            {month.slice(2)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-400">
        {series.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />{item.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function Sparkline({ values, color = '#34d399' }: { values: number[]; color?: string }) {
  const gradientId = useId().replace(/:/g, '');
  const max = niceMax(values) || 1;
  const width = 120;
  const height = 34;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, index) => `${index * stepX},${height - (value / max) * (height - 4)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-8 w-28" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
