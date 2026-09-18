import { DirectiveInterpretation, HourEntry, Battery, HourlyPlanEntry } from "./domain";
import solver from "javascript-lp-solver";

/**
 * LP-based optimizer using javascript-lp-solver.
 *
 * Variables per hour (h):
 *  - grid_h           >= 0
 *  - solar_used_h     >= 0
 *  - charge_h         >= 0
 *  - discharge_h      >= 0
 *
 * Objective: minimize sum_h grid_h * tariff_h
 *
 * Constraints (per hour):
 *  1) grid_h + solar_used_h + discharge_h = demand_h + charge_h
 *  2) solar_used_h <= effective_solar_h
 *  3) charge_h <= max_charge_per_hour
 *  4) discharge_h <= max_discharge_per_hour
 *  5) grid_h <= max_grid_h (if max_grid_window applies)
 *  6) charge_h = 0 for no_charge_window hours
 *  7) discharge_h = 0 for no_discharge_window hours
 *
 * Battery energy dynamics (for hours 0..23):
 *  energy_after_h = energy_after_{h-1} + charge_h - discharge_h
 *  energy_after_(-1) = initial_energy
 *  min_reserve_h <= energy_after_h <= capacity
 *
 * End-of-day neutrality:
 *  energy_after_23 = initial_energy
 *
 * Implementation notes:
 *  - javascript-lp-solver supports linear constraints with variable coefficients.
 *  - We encode energy dynamics by creating constraints that accumulate charge/discharge.
 */

type DirectiveMap = {
    solarFactor: number[]; // per hour
    minReserve: (number | null)[]; // per hour
    noCharge: boolean[];
    noDischarge: boolean[];
    maxGrid: (number | null)[];
};

function buildDirectiveMap(directives: DirectiveInterpretation[], battery: Battery): DirectiveMap {
    const solarFactor = new Array(24).fill(1);
    const minReserve: (number | null)[] = new Array(24).fill(null);
    const noCharge = new Array(24).fill(false);
    const noDischarge = new Array(24).fill(false);
    const maxGrid: (number | null)[] = new Array(24).fill(null);

    for (const d of directives) {
        if (!d.applies) continue;
        const adj: any = d.structured_adjustment;
        if (!adj) continue;
        const hours: number[] = adj.hours ?? [];
        switch (d.directive_type) {
            case "solar_reduction":
                for (const h of hours) {
                    const f = typeof adj.factor === "number" ? adj.factor : 1;
                    solarFactor[h] = Math.max(0, Math.min(1, f));
                }
                break;
            case "minimum_battery_reserve":
                for (const h of hours) {
                    const m = typeof adj.minimum_energy_kwh === "number" ? adj.minimum_energy_kwh : null;
                    minReserve[h] = m;
                }
                break;
            case "no_charge_window":
                for (const h of hours) noCharge[h] = true;
                break;
            case "no_discharge_window":
                for (const h of hours) noDischarge[h] = true;
                break;
            case "max_grid_window":
                for (const h of hours) {
                    const mg = typeof adj.max_grid_kwh === "number" ? adj.max_grid_kwh : null;
                    maxGrid[h] = mg;
                }
                break;
        }
    }

    for (let i = 0; i < 24; i++) {
        if (minReserve[i] === null) minReserve[i] = battery.minimum_energy_kwh;
    }

    return { solarFactor, minReserve, noCharge, noDischarge, maxGrid };
}

export function optimizeSchedule(
    directives: DirectiveInterpretation[],
    hours: HourEntry[],
    battery: Battery
): HourlyPlanEntry[] {
    // Defensive copy + sort by hour so the returned plan matches input ordering
    const sortedHours = [...hours].sort((a, b) => a.hour - b.hour);
    const map = buildDirectiveMap(directives, battery);

    // Build LP model
    const model: any = {
        optimize: "cost",
        opType: "min",
        constraints: {},
        variables: {},
        ints: {}, // not used; continuous variables
    };

    // Helper to var name
    const v = (prefix: string, h: number) => `${prefix}_${h}`;

    // Add variables and per-hour constraints
    for (let i = 0; i < 24; i++) {
        const hour = sortedHours.find((hh) => hh.hour === i);
        if (!hour) throw new Error(`Missing hour ${i} in hours[]`);

        const effectiveSolar = Number((hour.solar_kwh * (map.solarFactor[i] ?? 1)).toFixed(6));
        const maxCharge = battery.max_charge_kwh_per_hour;
        const maxDischarge = battery.max_discharge_kwh_per_hour;

        // Define variable objects in model.variables
        // Each variable is an object mapping constraint names to coefficients and cost
        // We'll add cost only to grid variables
        model.variables[v("grid", i)] = { cost: hour.tariff_bdt_per_kwh };
        model.variables[v("solar", i)] = { cost: 0 };
        model.variables[v("charge", i)] = { cost: 0 };
        model.variables[v("discharge", i)] = { cost: 0 };

        // 1) Energy balance: grid + solar + discharge - charge = demand
        const balanceName = `balance_${i}`;
        model.constraints[balanceName] = model.constraints[balanceName] || { equal: 0 };
        // We'll set equal to demand by adding coefficients now
        model.variables[v("grid", i)][balanceName] = 1;
        model.variables[v("solar", i)][balanceName] = 1;
        model.variables[v("discharge", i)][balanceName] = 1;
        model.variables[v("charge", i)][balanceName] = -1;
        // store RHS in constraint equal field temporarily as demand
        model.constraints[balanceName].equal = hour.demand_kwh;

        // 2) solar_used <= effectiveSolar
        const solarCapName = `solar_cap_${i}`;
        model.constraints[solarCapName] = { max: effectiveSolar };
        model.variables[v("solar", i)][solarCapName] = 1;

        // 3) charge <= maxCharge
        const chargeCapName = `charge_cap_${i}`;
        model.constraints[chargeCapName] = { max: maxCharge };
        model.variables[v("charge", i)][chargeCapName] = 1;

        // 4) discharge <= maxDischarge
        const dischargeCapName = `discharge_cap_${i}`;
        model.constraints[dischargeCapName] = { max: maxDischarge };
        model.variables[v("discharge", i)][dischargeCapName] = 1;

        // 5) max_grid_window if present
        if (typeof map.maxGrid[i] === "number") {
            const mgName = `max_grid_${i}`;
            model.constraints[mgName] = { max: map.maxGrid[i] as number };
            model.variables[v("grid", i)][mgName] = 1;
        }

        // 6) no_charge_window -> charge = 0
        if (map.noCharge[i]) {
            const ncName = `no_charge_${i}`;
            model.constraints[ncName] = { equal: 0 };
            model.variables[v("charge", i)][ncName] = 1;
        }

        // 7) no_discharge_window -> discharge = 0
        if (map.noDischarge[i]) {
            const ndName = `no_discharge_${i}`;
            model.constraints[ndName] = { equal: 0 };
            model.variables[v("discharge", i)][ndName] = 1;
        }
    }

    // Battery energy dynamics constraints:
    // We'll create cumulative constraints to represent energy_after_h >= minReserve and <= capacity
    // energy_after_h = initial + sum_{t=0..h} (charge_t - discharge_t)
    // So for each hour h:
    //   initial + sum(charge_t) - sum(discharge_t) >= minReserve_h
    //   initial + sum(charge_t) - sum(discharge_t) <= capacity

    const initialEnergy = battery.initial_energy_kwh;
    for (let h = 0; h < 24; h++) {
        const minName = `battery_min_${h}`;
        const maxName = `battery_max_${h}`;
        model.constraints[minName] = { min: (map.minReserve[h] ?? battery.minimum_energy_kwh) - initialEnergy };
        model.constraints[maxName] = { max: battery.capacity_kwh - initialEnergy };

        // For cumulative sums, add +1 for each charge_t and -1 for each discharge_t up to hour h
        for (let t = 0; t <= h; t++) {
            const chargeVar = v("charge", t);
            const dischargeVar = v("discharge", t);
            model.variables[chargeVar][minName] = (model.variables[chargeVar][minName] ?? 0) + 1;
            model.variables[dischargeVar][minName] = (model.variables[dischargeVar][minName] ?? 0) - 1;

            model.variables[chargeVar][maxName] = (model.variables[chargeVar][maxName] ?? 0) + 1;
            model.variables[dischargeVar][maxName] = (model.variables[dischargeVar][maxName] ?? 0) - 1;
        }
    }

    // End-of-day neutrality: energy_after_23 == initialEnergy -> sum(charge) - sum(discharge) over 0..23 == 0
    const eodName = "end_of_day_neutrality";
    model.constraints[eodName] = { equal: 0 };
    for (let t = 0; t < 24; t++) {
        const chargeVar = v("charge", t);
        const dischargeVar = v("discharge", t);
        model.variables[chargeVar][eodName] = (model.variables[chargeVar][eodName] ?? 0) + 1;
        model.variables[dischargeVar][eodName] = (model.variables[dischargeVar][eodName] ?? 0) - 1;
    }

    // All variables are implicitly >= 0 in javascript-lp-solver.
    // Solve
    let solution: any;
    try {
        solution = solver.Solve(model);
    } catch (err) {
        console.error("LP solver error:", err);
        throw new Error("Energy schedule infeasible under current constraints");
    }
    if (!solution || typeof solution !== "object") {
        throw new Error("Energy schedule infeasible under current constraints");
    }

    // Build hourly plan from solution
    const plan: HourlyPlanEntry[] = [];
    // Track battery energy by replaying charge/discharge from solution
    let batteryEnergy = initialEnergy;

    for (let i = 0; i < 24; i++) {
        const gridVal = Number(solution[v("grid", i)] ?? 0);
        const solarVal = Number(solution[v("solar", i)] ?? 0);
        const chargeVal = Number(solution[v("charge", i)] ?? 0);
        const dischargeVal = Number(solution[v("discharge", i)] ?? 0);

        // Determine battery action
        let battery_action: "charge" | "discharge" | "idle" = "idle";
        let battery_kwh = 0;
        if (chargeVal > 1e-9) {
            battery_action = "charge";
            battery_kwh = chargeVal;
            batteryEnergy += chargeVal;
        } else if (dischargeVal > 1e-9) {
            battery_action = "discharge";
            battery_kwh = dischargeVal;
            batteryEnergy -= dischargeVal;
        }

        plan.push({
            hour: sortedHours[i].hour,
            grid_kwh: Number(gridVal.toFixed(6)),
            solar_used_kwh: Number(solarVal.toFixed(6)),
            battery_action,
            battery_kwh: Number(battery_kwh.toFixed(6)),
            battery_energy_after_kwh: Number(Math.max(0, Math.min(battery.capacity_kwh, batteryEnergy)).toFixed(6)),
        });
    }

    // Verify end-of-day neutrality (numerical drift guard)
    const last = plan[plan.length - 1];
    if (Math.abs(last.battery_energy_after_kwh - initialEnergy) > 0.01) {
        throw new Error(
            `End-of-day battery neutrality violated: got ${last.battery_energy_after_kwh}, expected ${initialEnergy}`
        );
    }

    return plan;
}
