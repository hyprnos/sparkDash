import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { GpuMetrics, LlmMetrics, UnifiedMemoryMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { MemoryIcon } from "../ui/icons";
import { formatMb } from "../../shared/formatBytes";
import { memoryBreakdown, type MemSegment } from "./chartMath";
import { GpuProcessTable } from "./GpuPanel";

interface UnifiedMemoryPanelProps {
  um: UnifiedMemoryMetrics | null;
  gpu: GpuMetrics | null;
  llm: readonly LlmMetrics[] | undefined;
  className?: string;
}

/**
 * GB10 unified pool: one stacked bar (model weights / KV cache / system / free)
 * and the per-process table. The KV slice comes from the engines' allocated
 * pool (vLLM `cache_config_info`); without it the GPU slice stays whole.
 */
export function UnifiedMemoryPanel({ um, gpu, llm, className }: UnifiedMemoryPanelProps) {
  const { t } = useTranslation("spark");
  const total = um?.total ?? 0;
  const segments = useMemo(() => {
    if (!um || um.total <= 0) return [];
    const engines = (llm ?? []).filter((l) => l.available);
    const kvBytes = engines.reduce((sum, l) => sum + (l.kvCacheMemoryBytes ?? 0), 0);
    return memoryBreakdown({
      totalMb: um.total,
      gpuUsedMb: um.gpuUsed,
      cpuUsedMb: um.cpuUsed,
      kvBytes,
      hasModel: engines.length > 0 && um.gpuUsed > 0,
    });
  }, [um, llm]);

  const segmentLabel = (key: MemSegment["key"]): string => {
    switch (key) {
      case "weights":
        return t("gpu.memWeights");
      case "kv":
        return t("gpu.memKv");
      case "system":
        return t("gpu.memSystem");
      case "free":
        return t("gpu.memFree");
      default:
        return t("gpu.memGpuProcesses");
    }
  };

  const used = um?.used ?? 0;
  const pct = um?.percentage ?? 0;
  const processes = gpu?.processes ?? [];

  return (
    <Panel
      title={t("gpu.unifiedMemory")}
      icon={<MemoryIcon />}
      className={`panel-memory ${className ?? ""}`}
      bodyClassName="sp-stack"
      actions={
        total > 0 ? (
          <span className="mono sp-muted">
            {formatMb(used)} of {formatMb(total)} · {pct}%
          </span>
        ) : undefined
      }
    >
      {total > 0 ? (
        <>
          <div className="seg-bar sp-seg-bar" role="img" aria-label={t("gpu.memAria", { pct })}>
            {segments
              .filter((s) => s.mb > 0)
              .map((s) => (
                <i
                  key={s.key}
                  className={`sp-seg sp-seg--${s.key}`}
                  style={{ width: `${(s.mb / total) * 100}%` }}
                  title={`${segmentLabel(s.key)} ${formatMb(s.mb)}`}
                />
              ))}
          </div>
          <div className="legend">
            {segments.map((s) => (
              <span key={s.key} className={`sp-key sp-key--${s.key}`}>
                {segmentLabel(s.key)} {formatMb(s.mb)}
              </span>
            ))}
          </div>
          <div className="sp-chips">
            {um && um.oomRisk !== "low" && (
              <Tag tone={um.oomRisk === "high" ? "bad" : "warn"}>
                {um.oomRisk === "high" ? t("gpu.oomHigh") : t("gpu.memPressure")}
              </Tag>
            )}
            {um && um.bandwidth.current > 0 && (
              <Tag title={t("gpu.bandwidthTitle")}>
                {um.bandwidth.current.toFixed(1)} / {um.bandwidth.peak} GB/s
              </Tag>
            )}
          </div>
        </>
      ) : (
        <p className="sp-muted">{t("gpu.memoryWaiting")}</p>
      )}
      {processes.length > 0 && <GpuProcessTable processes={processes} />}
    </Panel>
  );
}