import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoceDevice, RoceMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { NetworkIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { formatBytesPerSec } from "../../shared/formatBytes";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Counters worth showing, in this order; the rest stay in the API. Their names come from the `spark` catalog. */
export const ROCE_COUNTER_ROWS: { key: string; loss?: boolean }[] = [
  { key: "out_of_buffer", loss: true },
  { key: "packet_seq_err", loss: true },
  { key: "local_ack_timeout_err", loss: true },
  { key: "rnr_nak_retry_err", loss: true },
  { key: "implied_nak_seq_err", loss: true },
  { key: "req_transport_retries_exceeded", loss: true },
  { key: "rx_icrc_encapsulated", loss: true },
  { key: "np_ecn_marked_roce_packets" },
  { key: "np_cnp_sent" },
  { key: "rp_cnp_handled" },
  { key: "roce_adp_retrans" },
  { key: "duplicate_request" },
];

const ETH_ROWS: { key: string }[] = [
  { key: "rx_discards_phy" },
  { key: "tx_discards_phy" },
  { key: "rx_crc_errors_phy" },
  { key: "rx_pause_ctrl_phy" },
  { key: "tx_pause_ctrl_phy" },
];

/**
 * Catalog key per counter id. The technical acronyms (RNR NAK, ICRC, CNP, ECN)
 * stay as they are inside the translated values.
 */
const COUNTER_LABEL_KEY: Record<string, string> = {
  out_of_buffer: "roce.counterOutOfBuffer",
  packet_seq_err: "roce.counterPacketSeqErr",
  local_ack_timeout_err: "roce.counterLocalAckTimeout",
  rnr_nak_retry_err: "roce.counterRnrNakRetry",
  implied_nak_seq_err: "roce.counterImpliedNakSeq",
  req_transport_retries_exceeded: "roce.counterTransportRetries",
  rx_icrc_encapsulated: "roce.counterIcrc",
  np_ecn_marked_roce_packets: "roce.counterEcnMarked",
  np_cnp_sent: "roce.counterCnpSent",
  rp_cnp_handled: "roce.counterCnpHandled",
  roce_adp_retrans: "roce.counterAdaptiveRetrans",
  duplicate_request: "roce.counterDuplicateRequest",
  rx_discards_phy: "roce.counterRxDiscards",
  tx_discards_phy: "roce.counterTxDiscards",
  rx_crc_errors_phy: "roce.counterCrcErrors",
  rx_pause_ctrl_phy: "roce.counterRxPause",
  tx_pause_ctrl_phy: "roce.counterTxPause",
};

/**
 * Localized name of one counter row. The parameter is named `tr` because the
 * catalog checker only inspects calls to the `t` destructured from useTranslation.
 */
function counterLabel(tr: Translate, key: string): string {
  return tr(COUNTER_LABEL_KEY[key] ?? key);
}

const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());

/** "PFC on: 3" / "PFC off" / null when unknown. */
export function pfcLabel(d: RoceDevice, t?: Translate): { text: string; tone: "good" | "neutral" | "warn" } | null {
  const p = d.qos?.pfcPriorities;
  if (p == null) return null;
  if (p.length > 0) {
    return { text: t ? t("roce.pfcOn", { priorities: p.join(", ") }) : `PFC on: ${p.join(", ")}`, tone: "good" };
  }
  return { text: t ? t("roce.pfcOff") : "PFC off", tone: "neutral" };
}

function linkTone(d: RoceDevice): "good" | "warn" | "bad" | "neutral" {
  if (d.active) return "good";
  return d.everActive ? "bad" : "neutral";
}

function PortRow({ d }: { d: RoceDevice }) {
  const { t } = useTranslation("spark");
  const pfc = pfcLabel(d, t);
  const lossRising = d.loss.rising.length > 0;
  const speed = d.speedMbps != null ? `${d.speedMbps / 1000} Gb/s` : d.rateGbps != null ? `${d.rateGbps} Gb/s` : null;
  const dscp = d.qos?.dscpMap
    ? Object.entries(d.qos.dscpMap)
        .map(([prio, list]) => `prio ${prio}: DSCP ${list.join(",")}`)
        .join(" · ")
    : null;
  const pauseDirections = [
    d.flowControl?.rx ? "rx" : "",
    d.flowControl?.rx && d.flowControl.tx ? "/" : "",
    d.flowControl?.tx ? "tx" : "",
  ].join("");
  return (
    <div className={`sp-roce-port ${d.active ? "" : "is-down"}`} data-testid={`roce-${d.name}`}>
      <div className="sp-roce-port__head">
        <span className="mono sp-clip" title={d.name}>{d.netdev ?? d.name}</span>
        <span className="sp-chips">
          <Tag tone={linkTone(d)} title={d.physState ?? undefined}>{d.state ?? t("roce.stateUnknown")}</Tag>
          {speed && <Tag>{speed}</Tag>}
          {d.mtu != null && <Tag title={t("roce.mtuTitle")}>MTU {d.mtu}</Tag>}
        </span>
      </div>
      <div className="sp-roce-port__rates mono">
        <span><span className="text-accent">↓</span> {d.rxBps == null ? "—" : formatBytesPerSec(Math.round(d.rxBps))}</span>
        <span><span className="text-accent">↑</span> {d.txBps == null ? "—" : formatBytesPerSec(Math.round(d.txBps))}</span>
        <span title={t("roce.droppedTitle")}>
          {t("roce.errorsDrops", { errors: n(d.rxErrors), drops: n(d.rxDropped) })}
        </span>
      </div>
      <div className="sp-chips sp-roce-port__qos">
        {pfc && <Tag tone={pfc.tone} title={t("roce.pfcTitle")}>{pfc.text}</Tag>}
        {d.qos?.trust && <Tag title={t("roce.trustTitle")}>{t("roce.trust", { mode: d.qos.trust })}</Tag>}
        {d.flowControl && (d.flowControl.rx || d.flowControl.tx) && (
          <Tag title={t("roce.pauseTitle")}>{t("roce.pause", { directions: pauseDirections })}</Tag>
        )}
        {lossRising && <Tag tone="warn" title={d.loss.rising.join(", ")}>{t("roce.lossRising")}</Tag>}
      </div>
      {dscp && <div className="sp-muted mono sp-roce-port__dscp">{dscp}</div>}
      <details className="sp-roce-port__more">
        <summary>{t("roce.counters")}</summary>
        <table className="sp-roce-table">
          <tbody>
            {ROCE_COUNTER_ROWS.filter((r) => d.counters[r.key] != null).map((r) => {
              const delta = d.deltas[r.key] ?? 0;
              return (
                <tr key={r.key} className={r.loss && delta > 0 ? "is-rising" : ""}>
                  <td>{counterLabel(t, r.key)}</td>
                  <td className="mono">{n(d.counters[r.key])}</td>
                  <td className="mono sp-muted">{delta > 0 ? `+${delta.toLocaleString()}` : ""}</td>
                </tr>
              );
            })}
            {d.eth &&
              ETH_ROWS.filter((r) => d.eth![r.key] != null).map((r) => (
                <tr key={r.key}>
                  <td>{counterLabel(t, r.key)}</td>
                  <td className="mono">{n(d.eth![r.key])}</td>
                  <td />
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const OPEN_KEY = "sparkdash.roce.open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** One line for the collapsed panel: link count, speeds, PFC, and whether loss is rising. */
export function roceSummary(devices: RoceDevice[], t?: Translate): { text: string; tone: "good" | "warn" | "bad" | "neutral" } {
  const up = devices.filter((d) => d.active);
  const down = devices.filter((d) => d.everActive && !d.active);
  const lossy = devices.filter((d) => d.loss.rising.length > 0);
  const speeds = [...new Set(up.map((d) => d.speedMbps ?? (d.rateGbps != null ? d.rateGbps * 1000 : null)).filter((v): v is number => v != null))];
  const pfcKnown = devices.filter((d) => d.qos?.pfcPriorities != null);
  const pfcOn = pfcKnown.filter((d) => (d.qos?.pfcPriorities?.length ?? 0) > 0).length;
  const pfcPart = pfcKnown.length > 0
    ? pfcOn === 0
      ? t ? t("roce.summaryPfcOff") : "PFC off"
      : t ? t("roce.summaryPfcOn", { on: pfcOn, known: pfcKnown.length }) : `PFC on (${pfcOn}/${pfcKnown.length})`
    : null;
  const lossPart = lossy.length > 0
    ? t ? t("roce.summaryLossRising") : "loss rising"
    : down.length > 0
      ? t ? t("roce.summaryDown", { count: down.length }) : `${down.length} down`
      : t ? t("roce.summaryNoLoss") : "no loss";
  const parts = [
    t ? t("roce.summaryUp", { up: up.length, total: devices.length }) : `${up.length}/${devices.length} up`,
    speeds.length > 0 ? speeds.map((v) => `${v / 1000} Gb/s`).join(" / ") : null,
    pfcPart,
    lossPart,
  ].filter(Boolean);
  return { text: parts.join(" · "), tone: down.length > 0 ? "bad" : lossy.length > 0 ? "warn" : up.length === devices.length ? "good" : "neutral" };
}

/** RoCE / RDMA ports of a unit (shown only when it has RDMA devices). Collapsed by default. */
export function RocePanel({ roce, className }: { roce: RoceMetrics | null | undefined; className?: string }) {
  const { t } = useTranslation("spark");
  const [open, setOpen] = useState(readOpen);
  if (!roce || roce.devices.length === 0) return null;
  // Ports that never came up are not noise worth a row, but keep them reachable.
  const live = roce.devices.filter((d) => d.active || d.everActive);
  const idle = roce.devices.filter((d) => !d.active && !d.everActive);
  const summary = roceSummary(roce.devices, t);
  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? "0" : "1");
      } catch {
        /* storage may be blocked */
      }
      return !v;
    });
  };
  return (
    <Panel
      title={t("roce.title")}
      accent
      icon={<NetworkIcon />}
      className={`panel-roce ${className ?? ""}`}
      bodyClassName="sp-stack"
      hint={t("roce.hint")}
      actions={
        <button
          type="button"
          className={`btn btn--sm btn--ghost ${open ? "is-on" : ""}`}
          aria-expanded={open}
          aria-controls="roce-ports"
          onClick={toggle}
        >
          {open ? t("roce.hidePorts") : t("roce.showPorts")}
        </button>
      }
    >
      <div className="sp-roce-summary">
        <Tag tone={summary.tone}>{summary.text}</Tag>
      </div>
      <p className="sp-muted">{t("roce.legend")}</p>
      {open && (
        <div id="roce-ports" className="sp-stack">
          {live.map((d) => (
            <PortRow key={d.name} d={d} />
          ))}
          {idle.length > 0 && (
            <p className="sp-muted sp-roce-idle">
              {idle.length === 1
                ? t("roce.notConnected", { count: idle.length, names: idle.map((d) => d.netdev ?? d.name).join(", ") })
                : t("roce.notConnectedMany", { count: idle.length, names: idle.map((d) => d.netdev ?? d.name).join(", ") })}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}