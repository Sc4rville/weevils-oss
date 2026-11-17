export interface AvailableModel {
 id: string
 label: string
 efforts: string[]
 defaultEffort?: string
}
/** Confirmed thread configuration, not telemetry of a turn already in progress. */
export interface ModelControls {
 threadId: string
 tool: 'codex' | 'claude'
 models: AvailableModel[]
 selected: { model?: string; effort?: string }
 active: boolean
 appliesTo: 'next-turn'
}
export interface ModelSelection { model: string; effort: string }
export const isModelControl = (text: string) => /^\/(?:model|effort)\s*$/i.test(text.trim())
