import {
    DirectiveInterpretation,
    StructuredAdjustment,
    DirectiveType,
} from "./domain";

const ALLOWED_TYPES: Set<DirectiveType> = new Set([
    "solar_reduction",
    "minimum_battery_reserve",
    "no_charge_window",
    "no_discharge_window",
    "max_grid_window",
    "no_op",
]);

function isFiniteNum(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

/**
 * parseHourToken(token)
 * - Accepts numbers, numeric strings, ranges like "18-20", and time ranges like "6pm-8pm" or "18:00-20:00".
 * - Returns an array of integer hours or null if token is invalid.
 */
function parseHourToken(token: unknown): number[] | null {
    if (typeof token === "number") {
        if (!Number.isInteger(token) || token < 0 || token > 23) return null;
        return [token];
    }

    if (typeof token !== "string") return null;
    const s = token.trim();

    // Plain integer string
    if (/^\d{1,2}$/.test(s)) {
        const n = Number(s);
        if (Number.isInteger(n) && n >= 0 && n <= 23) return [n];
        return null;
    }

    // Range like "18-20"
    const dashRange = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (dashRange) {
        const a = Number(dashRange[1]);
        const b = Number(dashRange[2]);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 23 || b > 23) return null;
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        const out: number[] = [];
        for (let h = start; h <= end; h++) out.push(h);
        return out;
    }

    // Time range like "6pm-8pm", "06:00-08:00", "18:00-20:00"
    const timeRange = s.match(/^(\d{1,2})(?::\d{2})?\s*(am|pm)?\s*-\s*(\d{1,2})(?::\d{2})?\s*(am|pm)?$/i);
    if (timeRange) {
        const parseHour = (numStr: string, ampm: string | undefined) => {
            let n = Number(numStr);
            if (ampm) {
                const ap = ampm.toLowerCase();
                if (ap === "pm" && n < 12) n += 12;
                if (ap === "am" && n === 12) n = 0;
            }
            return n;
        };
        const a = parseHour(timeRange[1], timeRange[2] || undefined);
        const b = parseHour(timeRange[3], timeRange[4] || undefined);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 23 || b > 23) return null;
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        const out: number[] = [];
        for (let h = start; h <= end; h++) out.push(h);
        return out;
    }

    return null;
}

/**
 * validHoursArray(hours)
 * - Accepts arrays of numbers, numeric strings, ranges, or time strings.
 * - Returns sorted unique integer array or null if invalid.
 */
function validHoursArray(hours: unknown): number[] | null {
    if (!Array.isArray(hours) || hours.length === 0) return null;
    const seen = new Set<number>();
    for (const token of hours) {
        const parsed = parseHourToken(token);
        if (!parsed) return null;
        for (const h of parsed) {
            if (!Number.isInteger(h) || h < 0 || h > 23) return null;
            seen.add(h);
        }
    }
    return clampHours([...seen]);
}

function noOpEntry(idx: number, explanation: string): DirectiveInterpretation {
    return {
        note_index: idx,
        applies: false,
        directive_type: "no_op",
        structured_adjustment: null,
        explanation,
    };
}

function clampHours(hours: number[]): number[] {
    return [...new Set(hours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort(
        (a, b) => a - b
    );
}

function sanitizeOne(
    raw: any,
    capacity: number,
    warnings: string[],
    idx: number
): DirectiveInterpretation {
    const type: DirectiveType = raw.directive_type;
    const explanation =
        typeof raw.explanation === "string" && raw.explanation.trim()
            ? raw.explanation.trim().slice(0, 500)
            : "No explanation provided.";

    if (!ALLOWED_TYPES.has(type)) {
        warnings.push(`note ${idx}: unsupported directive_type "${type}", defaulted to no_op`);
        return noOpEntry(idx, "Unsupported directive type; treated as no_op.");
    }

    if (type === "no_op") {
        return noOpEntry(idx, explanation);
    }

    if (raw.applies !== true) {
        warnings.push(`note ${idx}: applies must be true for non-no_op directive, defaulted to no_op`);
        return noOpEntry(idx, "Invalid applies flag; treated as no_op.");
    }

    const adj: StructuredAdjustment = raw.structured_adjustment;
    if (!adj || typeof adj !== "object") {
        warnings.push(`note ${idx}: missing structured_adjustment, defaulted to no_op`);
        return noOpEntry(idx, "Missing structured_adjustment; treated as no_op.");
    }

    // Prefer explicit integer hours array; if model provided hours_parsed, use that
    const rawHours = (adj as any).hours_parsed ?? (adj as any).hours;
    const hours = validHoursArray(rawHours);
    if (!hours) {
        warnings.push(`note ${idx}: invalid hours array, defaulted to no_op`);
        return noOpEntry(idx, "Invalid hours array; treated as no_op.");
    }

    switch (type) {
        case "solar_reduction": {
            const factor = (adj as any).factor;
            if (!isFiniteNum(factor) || factor < 0 || factor > 1) {
                warnings.push(`note ${idx}: invalid solar_reduction factor, defaulted to no_op`);
                return noOpEntry(idx, "Invalid solar reduction factor; treated as no_op.");
            }
            return {
                note_index: idx,
                applies: true,
                directive_type: type,
                structured_adjustment: { hours, factor },
                explanation,
            };
        }
        case "minimum_battery_reserve": {
            let minEnergyRaw: unknown = (adj as any).minimum_energy_kwh;

            // Accept percentage-like strings: "50%", "~50%", "about 50 percent", "50 percent"
            if (typeof minEnergyRaw === "string") {
                const s = minEnergyRaw.trim().toLowerCase();
                const pctMatch = s.match(/(-?\d+(?:\.\d+)?)\s*(?:%|percent)/);
                const halfMatch = s === "half" || s === "a half";
                if (pctMatch) {
                    const pct = parseFloat(pctMatch[1]);
                    if (!Number.isNaN(pct)) {
                        minEnergyRaw = (pct / 100) * capacity;
                        warnings.push(`note ${idx}: parsed percentage minimum_energy_kwh -> ${minEnergyRaw} kWh`);
                    }
                } else if (halfMatch) {
                    minEnergyRaw = capacity * 0.5;
                    warnings.push(`note ${idx}: parsed 'half' minimum_energy_kwh -> ${minEnergyRaw} kWh`);
                } else {
                    const parsed = parseFloat(s);
                    if (!Number.isNaN(parsed)) minEnergyRaw = parsed;
                }
            } else if (typeof minEnergyRaw === "number" && minEnergyRaw > 0 && minEnergyRaw <= 1) {
                // treat 0..1 as fraction of capacity
                minEnergyRaw = Number((minEnergyRaw * capacity).toFixed(6));
                warnings.push(`note ${idx}: interpreted fractional minimum_energy_kwh -> ${minEnergyRaw} kWh`);
            }

            const minEnergy = minEnergyRaw;
            if (!isFiniteNum(minEnergy) || minEnergy < 0 || minEnergy > capacity) {
                warnings.push(`note ${idx}: invalid minimum_energy_kwh, defaulted to no_op`);
                return noOpEntry(idx, "Invalid minimum reserve; treated as no_op.");
            }
            return {
                note_index: idx,
                applies: true,
                directive_type: type,
                structured_adjustment: { hours, minimum_energy_kwh: minEnergy },
                explanation,
            };
        }
        case "no_charge_window":
        case "no_discharge_window": {
            return {
                note_index: idx,
                applies: true,
                directive_type: type,
                structured_adjustment: { hours },
                explanation,
            };
        }
        case "max_grid_window": {
            const maxGrid = (adj as any).max_grid_kwh;
            if (!isFiniteNum(maxGrid) || maxGrid < 0) {
                warnings.push(`note ${idx}: invalid max_grid_kwh, defaulted to no_op`);
                return noOpEntry(idx, "Invalid max grid value; treated as no_op.");
            }
            return {
                note_index: idx,
                applies: true,
                directive_type: type,
                structured_adjustment: { hours, max_grid_kwh: maxGrid },
                explanation,
            };
        }
    }
}

export function guardrailValidate(
    rawEntries: any[],
    noteCount: number,
    batteryCapacityKwh: number
): { sanitized: DirectiveInterpretation[]; warnings: string[] } {
    const warnings: string[] = [];
    const byIndex = new Map<number, DirectiveInterpretation>();

    const arr = Array.isArray(rawEntries) ? rawEntries : [];
    for (const raw of arr) {
        if (!raw || typeof raw !== "object") {
            warnings.push("discarded non-object entry");
            continue;
        }
        const idx = raw.note_index;
        if (!Number.isInteger(idx) || idx < 0 || idx >= noteCount) {
            warnings.push(`discarded entry with invalid note_index=${idx}`);
            continue;
        }
        if (byIndex.has(idx)) {
            warnings.push(`duplicate note_index=${idx}, keeping first`);
            continue;
        }
        byIndex.set(idx, sanitizeOne(raw, batteryCapacityKwh, warnings, idx));
    }

    const sanitized: DirectiveInterpretation[] = [];
    for (let i = 0; i < noteCount; i++) {
        if (byIndex.has(i)) {
            sanitized.push(byIndex.get(i)!);
        } else {
            warnings.push(`missing note_index=${i}, defaulted to no_op`);
            sanitized.push(noOpEntry(i, "No interpretation returned; treated as no_op."));
        }
    }
    return { sanitized, warnings };
}
