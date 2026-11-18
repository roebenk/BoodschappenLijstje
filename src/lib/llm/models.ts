// OpenRouter published text token prices, checked 18 November 2026.
export const AI_MODELS = [
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", description: "Aanbevolen: voordelig en snel", input: 0.10, output: 0.40 },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2", description: "Goedkoop alternatief", input: 0.075, output: 0.20 },
  { id: "openai/gpt-4.1-nano", name: "GPT-4.1 Nano", description: "Compact alternatief", input: 0.10, output: 0.40 },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", description: "Uitgebreider, hogere prijs", input: 0.40, output: 1.60 },
  { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite", description: "Nieuwere preview, hogere prijs", input: 0.25, output: 1.50 },
] as const;

// 100 new searches: each has a 500/100-token expansion and a 2000/200-token relevance check.
export function estimatedMonthlyCost(model: { input: number; output: number }): number {
  return (250_000 * model.input + 30_000 * model.output) / 1_000_000;
}
