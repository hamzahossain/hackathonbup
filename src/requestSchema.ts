import { z } from 'zod';

/**
 * Structural validation for the incoming POST /optimize-energy request body.
 */

const hourEntrySchema = z.object({
    hour: z.number().int().min(0).max(23),
    demand_kwh: z.number().finite().nonnegative(),
    solar_kwh: z.number().finite().nonnegative(),
    tariff_bdt_per_kwh: z.number().finite().nonnegative(),
});

const batterySchema = z.object({
    capacity_kwh: z.number().finite().positive(),
    initial_energy_kwh: z.number().finite().nonnegative(),
    minimum_energy_kwh: z.number().finite().nonnegative(),
    max_charge_kwh_per_hour: z.number().finite().nonnegative(),
    max_discharge_kwh_per_hour: z.number().finite().nonnegative(),
});

export const optimizeEnergyRequestSchema = z
    .object({
        scenario_id: z.string().min(1),
        operator_notes: z.array(z.string().min(1)).min(1).max(3),
        hours: z.array(hourEntrySchema).length(24),
        battery: batterySchema,
    })
    .superRefine((data, ctx) => {
        const seen = new Set<number>();
        for (const h of data.hours) {
            if (seen.has(h.hour)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate hour value ${h.hour} in hours[]` });
            }
            seen.add(h.hour);
        }
        for (let i = 0; i < 24; i++) {
            if (!seen.has(i)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: `missing hour ${i} in hours[]` });
            }
        }
        if (data.battery.initial_energy_kwh > data.battery.capacity_kwh) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'battery.initial_energy_kwh exceeds capacity_kwh' });
        }
        if (data.battery.minimum_energy_kwh > data.battery.capacity_kwh) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'battery.minimum_energy_kwh exceeds capacity_kwh' });
        }
        if (data.battery.initial_energy_kwh < data.battery.minimum_energy_kwh) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'battery.initial_energy_kwh is below minimum_energy_kwh' });
        }
    });

export type ValidatedOptimizeEnergyRequest = z.infer<typeof optimizeEnergyRequestSchema>;
