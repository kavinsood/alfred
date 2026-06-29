// Single source of truth for runtime configuration.

// The model id. Override with ALFRED_MODEL. Branding: "Opus 4.7".
export const MODEL = process.env.ALFRED_MODEL ?? "claude-opus-4-7";
