import AstalBattery from "gi://AstalBattery"

// UPower's display battery. Where UPower isn't running there is none at all
// (get_default() is null), and the shell, reading it at startup in a dozen
// places, didn't start; a stand-in with nothing in it reads as no battery,
// which is what a machine without UPower has to show.
export const battery: AstalBattery.Device = AstalBattery.get_default() ?? new AstalBattery.Device()
