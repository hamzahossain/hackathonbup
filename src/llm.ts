import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import type { DirectiveInterpretation } from "./domain";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const modelName = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

let client: any = null;
let model: any = null;
if (apiKey) {
    try {
        client = new GoogleGenerativeAI(apiKey);
        model = client.getGenerativeModel({ model: modelName });
    } catch (err) {
        console.error("Failed to initialize Gemini client:", err);
        client = null;
        model = null;
    }
}

/**
 * interpretNotes(notes, batteryCapacityKwh)
 * - Asks the LLM to return a JSON array of directive objects.
 * - IMPORTANT: prompt requests absolute kWh for any energy amounts; asks model to convert percentages/fractions.
 * - Also requests hours as integer arrays and allows ranges/time strings but asks the model to include a parsed integer array.
 */
export async function interpretNotes(
    notes: string[],
    batteryCapacityKwh: number
): Promise<DirectiveInterpretation[]> {
    if (!model) {
        return notes.map((_, idx) => ({
            note_index: idx,
            applies: false,
            directive_type: "no_op",
            structured_adjustment: null,
            explanation: "LLM unavailable; defaulted to no_op",
        }));
    }

    const prompt = [
        "You are a structured interpreter for GridWise operator notes.",
        "For each note return exactly one JSON object with fields:",
        "  note_index (int), applies (true/false), directive_type (one of: solar_reduction, minimum_battery_reserve, no_charge_window, no_discharge_window, max_grid_window, no_op), structured_adjustment (object or null), explanation (short string).",
        "Return a JSON array only (no extra text).",
        "IMPORTANT TIME-WINDOW RULE: Time windows are START-INCLUSIVE and END-EXCLUSIVE. So \"12 PM to 2 PM\" maps to hours [12, 13]. \"6 PM to 8 PM\" maps to hours [18, 19]. \"from 18:00 to 20:00\" maps to hours [18, 19]. Never add an extra hour for the end of the window.",
        "IMPORTANT ENERGY RULE: When you specify any energy amount (for example minimum battery reserve), ALWAYS return it as an absolute kWh NUMBER (not a string, not a percentage, not a fraction).",
        "If the operator gives a percentage (e.g., 50%) or a fraction (e.g., 0.5) of battery capacity, COMPUTE the kWh yourself using the battery capacity below and return that numeric kWh value in structured_adjustment.",
        `Battery capacity_kwh: ${batteryCapacityKwh}. Example: 50% of ${batteryCapacityKwh} kWh = ${batteryCapacityKwh * 0.5} kWh.`,
        "IMPORTANT HOURS RULE: ALWAYS return hours as an array of integers 0..23 in ascending order, with no duplicates (e.g., [18, 19]). Do NOT return ranges, time strings, or 24. Treat \"to\" or \"until\" as end-exclusive.",
        "If the note does not affect today's 24-hour energy schedule (e.g., scheduling, deadlines, announcements), set applies=false, directive_type=\"no_op\", structured_adjustment=null.",
        "Input notes:",
        JSON.stringify(notes, null, 2),
        "Example output:",
        `[{"note_index":0,"applies":true,"directive_type":"solar_reduction","structured_adjustment":{"hours":[12,13],"factor":0.25},"explanation":"..."},{"note_index":1,"applies":true,"directive_type":"minimum_battery_reserve","structured_adjustment":{"hours":[18,19],"minimum_energy_kwh":110},"explanation":"..."}]`
    ].join("\n\n");

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const firstBracket = text.indexOf("[");
        const lastBracket = text.lastIndexOf("]");
        const jsonText = firstBracket >= 0 && lastBracket >= 0 ? text.slice(firstBracket, lastBracket + 1) : text;
        const parsed = JSON.parse(jsonText);
        if (!Array.isArray(parsed)) throw new Error("Parsed LLM output is not an array");
        return parsed.map((p: any, idx: number) => ({
            note_index: typeof p.note_index === "number" ? p.note_index : idx,
            applies: !!p.applies,
            directive_type: typeof p.directive_type === "string" ? p.directive_type : "no_op",
            structured_adjustment: p.structured_adjustment ?? null,
            explanation: typeof p.explanation === "string" ? p.explanation : "No explanation",
        }));
    } catch (err) {
        console.error("LLM interpretation failed or returned invalid JSON:", err);
        return notes.map((_, idx) => ({
            note_index: idx,
            applies: false,
            directive_type: "no_op",
            structured_adjustment: null,
            explanation: "LLM error or invalid output; defaulted to no_op",
        }));
    }
}
