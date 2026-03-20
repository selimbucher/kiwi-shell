import { Gtk } from 'ags/gtk4'
import { exec } from 'ags/process';
import { createState, With } from 'ags'
import { createPoll } from 'ags/time'

import { CircularProgress } from '../../../Misc';
import { Icon } from "../../../iconNames";
import { gpuUsage, ramUsage, cpuTemp } from "./hardwarePolling"
import { conf } from '../../../config';

function readCpuTicks(): [number, number] {
  const line = exec("bash -c \"grep -m1 'cpu ' /proc/stat\"")
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  const idle = parts[3] + parts[4]
  const total = parts.reduce((a, b) => a + b, 0)
  return [idle, total]
}

let [prevIdle, prevTotal] = readCpuTicks()

const cpuUsage = createPoll(0, 1000, () => {
  const [idle, total] = readCpuTicks()
  const diffIdle = idle - prevIdle
  const diffTotal = total - prevTotal
  ;[prevIdle, prevTotal] = [idle, total]
  return diffTotal === 0 ? 0 : 1 - diffIdle / diffTotal
})

export default function PerformanceTab({visible}) {
    return (
        <box>
            <With value={visible}>
                {(isVisible) => isVisible ? (
                    <box orientation={Gtk.Orientation.VERTICAL}>
                        <box class="large-header">
                            Performance Graphs
                        </box>
                        <box hexpand halign={Gtk.Align.CENTER} class="performance-graphs" spacing={8}>
                            <PerformanceGraph
                                progress={cpuUsage}
                                icon="am-cpu-symbolic"
                                color="#68b3e5"
                            />
                            <PerformanceGraph
                                progress={gpuUsage}
                                icon="gpu-symbolic"
                                color="#e56868"
                            />
                            <PerformanceGraph
                                progress={ramUsage}
                                icon="nvidia-ram-symbolic"
                                color="#7fea7f"
                            />
                            <PerformanceGraph
                                // Normalize to 0–1 for the ring (capped at 100°C)
                                progress={cpuTemp(t => Math.min(t / 100, 1))}
                                icon="am-temperature-symbolic"
                                color={conf(conf => conf.primary_color)}
                                labelFn={cpuTemp(t => `${Math.round(t)}°C`)}
                            />
                        </box>
                    </box>
                ) : (
                    <box />
                )}
            </With>
        </box>
    )
}

function PerformanceGraph({progress, icon, color, labelFn = null}) {
    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <overlay>
                <Icon
                    pixelSize={20}
                    iconName={icon}
                    $type="overlay"
                />
                <CircularProgress progress={progress} color={color} lineWidth={6}/>
            </overlay>
            <label
                class="performance-label"
                label={labelFn ?? progress(p => `${Math.round(p * 100)}%`)}
                halign={Gtk.Align.CENTER}
            />
        </box>
    )
}