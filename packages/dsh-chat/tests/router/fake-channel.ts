import type { ChatChannel, Delivered, TurnReport, TurnSink } from '../../src/router/channel.ts'

/** Records everything the core asks of a channel; `failDeliver` makes the next delivery throw. */
export class FakeChannel implements ChatChannel {
  readonly bot: { id: string; name: string }
  sent: { chatId: string; text: string; replyTo?: string }[] = []
  reactions: { chatId: string; messageId: string; emoji: string }[] = []
  turns: { chatId: string; replyTo?: string; status: string[]; reports: TurnReport[]; closed: boolean }[] = []
  failDeliver = false

  constructor(readonly id: string) {
    this.bot = { id: `${id}-bot`, name: `${id}bot` }
  }

  async openTurn(chatId: string, origin: { replyTo?: string }): Promise<TurnSink> {
    const turn = { chatId, ...origin, status: [] as string[], reports: [] as TurnReport[], closed: false }
    this.turns.push(turn)
    return {
      status: (tool) => { turn.status.push(tool) },
      deliver: async (report) => {
        turn.reports.push(report)
        if (this.failDeliver) {
          this.failDeliver = false
          throw new Error('deliver failed')
        }
        return { outcome: 'sent', messageId: `r${this.turns.length}` }
      },
      close: () => { turn.closed = true },
    }
  }

  async send(chatId: string, text: string, opts: { replyTo?: string } = {}): Promise<Delivered> {
    this.sent.push({ chatId, text, ...opts })
    return { as: 'native', messageId: `s${this.sent.length}`, text }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<Delivered> {
    this.reactions.push({ chatId, messageId, emoji })
    return { as: 'native' }
  }
}
