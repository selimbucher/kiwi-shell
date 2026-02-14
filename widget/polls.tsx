import { createPoll } from "ags/time";
import { exec } from "ags/process";
import { readFile } from "ags/file";

// Helper to check if a path exists
const pathExists = (path: string) => {
    try {
        return exec(`sh -c 'test -e ${path} && echo true'`).trim() === "true";
    } catch {
        return false;
    }
};

// --- Screen Brightness ---
export const brightness = createPoll(0, 200, () => {
    try {
        return parseInt(exec("brightnessctl get")) || 0;
    } catch {
        return 0;
    }
});

const kbdPathRaw = exec("sh -c 'ls /sys/class/leds/*kbd*/brightness 2>/dev/null'").split('\n')[0].trim();
const kbdMaxPathRaw = exec("sh -c 'ls /sys/class/leds/*kbd*/max_brightness 2>/dev/null'").split('\n')[0].trim();

export const hasKbdBacklight = kbdPathRaw !== "" && pathExists(kbdPathRaw);

// --- Keyboard Polls ---
export const max_keyboardBrightness = hasKbdBacklight 
    ? parseInt(readFile(kbdMaxPathRaw)) 
    : 1; // Default to 1 to avoid Division by Zero in your UI

export const keyboardBrightness = createPoll(
    0, 
    hasKbdBacklight ? 200 : 1000000, // Poll extremely slowly if no hardware exists
    () => {
        if (!hasKbdBacklight) return 0;
        try {
            return parseInt(readFile(kbdPathRaw)) || 0;
        } catch {
            return 0;
        }
    }
);