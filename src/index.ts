import express from "express";
import dotenv from "dotenv";
import { interpretNotes } from "./llm";
import { guardrailValidate } from "./guardrails";
import { optimizeSchedule } from "./optimizer";
import { optimizeEnergyRequestSchema, ValidatedOptimizeEnergyRequest } from "./requestSchema";
import type { OptimizeEnergyResponse } from "./domain";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8000);
const exposeWarnings = process.env.NODE_ENV !== "dev";
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

app.post("/optimize-energy", async (req, res) => {
    try {
        // Validate request structure
        const body: ValidatedOptimizeEnergyRequest = optimizeEnergyRequestSchema.parse(req.body);

        // LLM interpretation (pass battery capacity so model can convert percentages)
        const rawDirectives = await interpretNotes(body.operator_notes, body.battery.capacity_kwh);

        // Guardrail validation (sanitizes and returns warnings)
        const { sanitized, warnings } = guardrailValidate(
            rawDirectives,
            body.operator_notes.length,
            body.battery.capacity_kwh
        );

        // Optimization
        const hourlyPlan = optimizeSchedule(sanitized, body.hours, body.battery);

        // Totals
        let totalGrid = 0;
        let totalCost = 0;
        let peakGrid = 0;
        for (let i = 0; i < hourlyPlan.length; i++) {
            const p = hourlyPlan[i];
            const hourInfo = body.hours.find((h) => h.hour === p.hour)!;
            totalGrid += p.grid_kwh;
            totalCost += p.grid_kwh * hourInfo.tariff_bdt_per_kwh;
            peakGrid = Math.max(peakGrid, p.grid_kwh);
        }

        const response: OptimizeEnergyResponse & { warnings?: string[] } = {
            scenario_id: body.scenario_id,
            directive_interpretation: sanitized,
            hourly_plan: hourlyPlan,
            total_grid_kwh: Number(totalGrid.toFixed(6)),
            total_cost_bdt: Number(totalCost.toFixed(6)),
            peak_grid_kwh: Number(peakGrid.toFixed(6)),
            plan_summary: `Applied ${sanitized.filter(s => s.applies).length} directives; ${warnings.length ? `warnings: ${warnings.join("; ")}` : "no guardrail warnings"}.`,
        };

        res.json(response);
    } catch (err: any) {
        if (err && err.issues) {
            // Zod validation error
            res.status(400).json({ error: "Invalid request", details: err.issues });
        } else {
            console.error("Internal error:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
