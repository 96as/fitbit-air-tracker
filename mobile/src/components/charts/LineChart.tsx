import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { CHART, SERIES } from '../dashboard/format';
import { domainFor, PAD, Readout, RefKey, SURFACE, summarize, useSelection, useWidth, xLabelIndexes, type Datum, type RefLine } from './common';

/**
 * Single-series line (2px, round joins). Missing days break the line instead
 * of being bridged; isolated points get a dot so they stay visible. The
 * selected / latest point gets an 8px marker with a 2px surface ring and a
 * hairline crosshair.
 */
export function LineChart({
  title,
  data,
  format,
  tickFormat = (v) => String(v),
  refLine,
  domain,
  ticks: fixedTicks,
  minSpan,
  height = 120,
}: {
  title: string;
  data: Datum[];
  format: (v: number) => string;
  tickFormat?: (v: number) => string;
  refLine?: RefLine;
  /** Fixed y-domain, e.g. [0, 100] for scores or [1, 5] for mood. */
  domain?: [number, number];
  /** Explicit tick values (use with `domain`). */
  ticks?: number[];
  /** Smallest y-span shown (e.g. 10 bpm), so small day-to-day wiggles stay small. */
  minSpan?: number;
  height?: number;
}) {
  const { width, onLayout } = useWidth();
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const { lo, hi, ticks } = domainFor(data.map((d) => d.value), refLine ? [refLine.value] : [], domain, false, fixedTicks, minSpan);
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const sel = useSelection(data, PAD.left, plotW);
  const slot = sel.step;
  const x = (i: number) => PAD.left + i * slot + slot / 2;

  // Build path segments, breaking on nulls.
  const segments: string[] = [];
  const singles: number[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length === 1) singles.push(run[0]!);
    if (run.length > 1) segments.push(run.map((i, k) => `${k ? 'L' : 'M'}${x(i)},${y(data[i]!.value!)}`).join(' '));
    run = [];
  };
  data.forEach((d, i) => (d.value == null ? flush() : run.push(i)));
  flush();

  const active = data[sel.active];

  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={summarize(title, data, format)}
      accessibilityValue={{ text: active ? `${active.longLabel}: ${active.value == null ? 'no data' : format(active.value)}` : undefined }}
      accessibilityActions={sel.a11yActions}
      onAccessibilityAction={sel.onA11yAction}
    >
      <Readout datum={active} format={format} />
      <View>
        <Svg width={width} height={height}>
          {ticks.map((t) => (
            <Line key={t} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === lo ? CHART.axis : CHART.grid} strokeWidth={1} />
          ))}
          {ticks.map((t) => (
            <SvgText key={`l${t}`} x={PAD.left - 6} y={y(t) + 4} fontSize={10} fill={CHART.ref} textAnchor="end">
              {tickFormat(t)}
            </SvgText>
          ))}
          {refLine && (
            <>
              <Line x1={PAD.left} x2={width - PAD.right} y1={y(refLine.value)} y2={y(refLine.value)} stroke={CHART.ref} strokeWidth={1} opacity={0.8} />
            </>
          )}
          {sel.touched && active && (
            <Line x1={x(sel.active)} x2={x(sel.active)} y1={PAD.top} y2={PAD.top + plotH} stroke={CHART.ref} strokeWidth={1} />
          )}
          {segments.map((d, i) => (
            <Path key={i} d={d} stroke={SERIES} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {singles.map((i) => (
            <Circle key={`s${i}`} cx={x(i)} cy={y(data[i]!.value!)} r={3} fill={SERIES} />
          ))}
          {active && active.value != null && (
            <Circle cx={x(sel.active)} cy={y(active.value)} r={5} fill={SERIES} stroke={SURFACE} strokeWidth={2} />
          )}
          {xLabelIndexes(data.length).map((i) => (
            <SvgText
              key={`x${i}`}
              x={x(i)}
              y={height - 5}
              fontSize={10}
              fill={i === sel.active ? '#e2e8f0' : CHART.ref}
              textAnchor={data.length > 7 ? (i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle') : 'middle'}
            >
              {data[i]!.label}
            </SvgText>
          ))}
        </Svg>
        <View style={StyleSheet.absoluteFill} {...sel.touch} />
      </View>
      {refLine && <RefKey label={refLine.label} />}
    </View>
  );
}
