export type OutboxStatus = 'accepted' | 'delivering' | 'delivered' | 'uncertain' | 'failed'
export interface OutboxReceipt {
  messageId: string
  status: OutboxStatus
  acceptedAt: number
  updatedAt: number
  id?: string
  result?: { id?: string; ok?: boolean; [key: string]: unknown }
  error?: string
}
