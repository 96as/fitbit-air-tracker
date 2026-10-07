import { StyleSheet, View } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { CHART, SERIES } from '../dashboard/format';
import { domainFor, PAD, Readout, RefKey, summarize, useSelection, useWidth, xLabelIndexes, type Datum, type RefLine } from './common';

/** Column path: 4px rounded data-end, square at the baseline. */
function columnPath(x: number, w: number, yTop: number, yBase: number): string {
  const h = yBase - yTop;
  const r = Math.max(0, Math.min(4, w / 2, h));
  return `M${x},${yBase} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yBase} Z`;
}

export function BarChart({
  title,
  data,
  format,
  tickFormat = (v) => String(v),
  refLine,
  height = 130,
}: {
  title: string;
  data: Datum[];
  format: (v: number) => string;
  tickFormat?: (v: number) => string;
  refLine?: RefLine;
  height?: number;
}) {
  const { width, onLayout } = useWidth();
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const { lo, hi, ticks } = domainFor(data.map((d) => d.value), refLine ? [refLine.value] : [], undefined, true);
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const sel = useSelection(data, PAD.left, plotW);
  const slot = sel.step;
  const barW = Math.max(2, Math.min(24, slot - 2)); // ≥2px surface gap between neighbours
  const base = y(lo);

  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={summarize(title, data, format)}
      accessibilityValue={{ text: data[sel.active] ? `${data[sel.active]!.longLabel}: ${data[sel.active]!.value == null ? 'no data' : format(data[sel.active]!.value!)}` : undefined }}
      accessibilityActions={sel.a11yActions}
      onAccessibilityAction={sel.onA11yAction}
    >
      <Readout datum={data[sel.active]} format={format} />
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
          {data.map((d, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            if (d.value == null) {
              return <Rect key={d.key} x={x} y={base - 2} width={barW} height={2} fill={CHART.empty} />;
            }
            const dim = sel.touched && i !== sel.active;
            return <Path key={d.key} d={columnPath(x, barW, y(d.value), base)} fill={SERIES} opacity={dim ? 0.45 : 1} />;
          })}
          {refLine && (
            <>
              <Line x1={PAD.left} x2={width - PAD.right} y1={y(refLine.value)} y2={y(refLine.value)} stroke={CHART.ref} strokeWidth={1.5} />
            </>
          )}
          {xLabelIndexes(data.length).map((i) => (
            <SvgText
              key={`x${i}`}
              x={PAD.left + i * slot + slot / 2}
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
