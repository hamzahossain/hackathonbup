
export type DirectiveType =
    | 'solar_reduction'
    | 'minimum_battery_reserve'
    | 'no_charge_window'
    | 'no_discharge_window'
    | 'max_grid_window'
    | 'no_op';

export const DIRECTIVE_TYPES: DirectiveType[] = [
    'solar_reduction',
    'minimum_battery_reserve',
    'no_charge_window',
    'no_discharge_window',
    'max_grid_window',
    'no_op',
];

export interface SolarReductionAdjustment {
    hours: number[];
    factor: number;
}
export interface MinimumBatteryReserveAdjustment {
    hours: number[];
    minimum_energy_kwh: number;
}
export interface NoChargeWindowAdjustment {
    hours: number[];
}
export interface NoDischargeWindowAdjustment {
    hours: number[];
}
export interface MaxGridWindowAdjustment {
    hours: number[];
    max_grid_kwh: number;
}

export type StructuredAdjustment =
    | SolarReductionAdjustment
    | MinimumBatteryReserveAdjustment
    | NoChargeWindowAdjustment
    | NoDischargeWindowAdjustment
    | MaxGridWindowAdjustment
    | null;

export interface DirectiveInterpretation {
    note_index: number;
    applies: boolean;
    directive_type: DirectiveType;
    structured_adjustment: StructuredAdjustment;
    explanation: string;
}

export interface HourEntry {
    hour: number;
    demand_kwh: number;
    solar_kwh: number;
    tariff_bdt_per_kwh: number;
}

export interface Battery {
    capacity_kwh: number;
    initial_energy_kwh: number;
    minimum_energy_kwh: number;
    max_charge_kwh_per_hour: number;
    max_discharge_kwh_per_hour: number;
}

export interface OptimizeEnergyRequest {
    scenario_id: string;
    operator_notes: string[];
    hours: HourEntry[];
    battery: Battery;
}

export type BatteryAction = 'charge' | 'discharge' | 'idle';

export interface HourlyPlanEntry {
    hour: number;
    grid_kwh: number;
    solar_used_kwh: number;
    battery_action: BatteryAction;
    battery_kwh: number;
    battery_energy_after_kwh: number;
}

export interface OptimizeEnergyResponse {
    scenario_id: string;
    directive_interpretation: DirectiveInterpretation[];
    hourly_plan: HourlyPlanEntry[];
    total_grid_kwh: number;
    total_cost_bdt: number;
    peak_grid_kwh: number;
    plan_summary: string;
}