import { isModelControl } from '../shared/model-controls'
export const MODEL_CONTROL_EVENT = 'weevils:model-controls'
export function openModelControls(id: string) {
 window.dispatchEvent(new CustomEvent(MODEL_CONTROL_EVENT,{detail:{id}}))
}
export function interceptModelControl(id: string,text: string,attachments=0) {
 if (attachments || !isModelControl(text)) return false
 openModelControls(id)
 return true
}
