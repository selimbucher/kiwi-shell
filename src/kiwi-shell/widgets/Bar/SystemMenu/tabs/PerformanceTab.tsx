import { Gtk } from 'ags/gtk4'
import { With } from 'ags'
import Pango from 'gi://Pango'

import { CircularProgress } from '../../../Misc';
import { Icon } from "../../../iconNames";
import { cpuUsage, gpuUsage, ramUsage, cpuTemp, hardwareAvailable } from "./hardwarePolling"
import { conf } from '../../../config';
import { significantEnergy, weighingEnergy, GroupIcon, type Group } from '../../../Island/sources/performance';

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
                                visible={hardwareAvailable(a => a.gpu)}
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
                                visible={hardwareAvailable(a => a.cpuTemp)}
                                // Normalize to 0–1 for the ring (capped at 100°C)
                                progress={cpuTemp(t => Math.max(0, Math.min(t / 100, 1)))}
                                icon="am-temperature-symbolic"
                                color={conf(conf => conf.primary_color)}
                                labelFn={cpuTemp(t => `${Math.round(t)}°C`)}
                            />
                        </box>
                        <Energy />
                    </box>
                ) : (
                    <box />
                )}
            </With>
        </box>
    )
}

function PerformanceGraph({progress, icon, color, labelFn = null, visible = true}) {
    return (
        <box orientation={Gtk.Orientation.VERTICAL} visible={visible}>
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

// macOS's battery menu list; kiwi has no battery menu, so it's here
// (Island/sources/performance.tsx weighs the apps)
function Energy() {
    return (
        <box class="energy" orientation={Gtk.Orientation.VERTICAL} visible={weighingEnergy}>
            <label class="energy-title" label="Using Significant Energy" xalign={0} />
            <With value={significantEnergy}>
                {(apps: Group[]) => apps.length === 0
                    ? <label class="energy-none" label="No Apps Using Significant Energy" xalign={0} />
                    : <box orientation={Gtk.Orientation.VERTICAL}>
                        {apps.map(app => (
                            <box class="energy-app" spacing={8}>
                                <GroupIcon group={app} size={16} />
                                <label label={app.name} xalign={0} hexpand
                                    ellipsize={Pango.EllipsizeMode.END} maxWidthChars={1} />
                            </box>
                        ))}
                    </box>}
            </With>
        </box>
    )
}
