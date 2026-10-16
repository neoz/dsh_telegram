/** Who sent the running turn, in channel-neutral form. */
export interface ChatSender { id: string; name: string; username?: string }

/** Who started the turn running in a chat, whether that chat is a group, and whether the sender is a super admin there. */
export interface TurnContext { sender: ChatSender; isGroup: boolean; isSuperAdmin: boolean }
