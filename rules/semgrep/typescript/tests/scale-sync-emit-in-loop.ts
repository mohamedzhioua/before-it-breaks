// Test cases for scale-sync-emit-in-loop (invented notes platform).

class NotificationFanout {
  constructor(private eventEmitter: any, private queue: any) {}

  shareWithMembers(note: any, members: any[]) {
    for (const member of members) {
      // ruleid: scale-sync-emit-in-loop
      this.eventEmitter.emit('note.shared', { noteId: note.id, userId: member.id });
    }
  }

  mentionUsers(note: any, userIds: string[]) {
    userIds.forEach((userId) => {
      // ruleid: scale-sync-emit-in-loop
      this.eventEmitter.emit('note.mentioned', { noteId: note.id, userId });
    });
  }

  remind(due: any[]) {
    for (let i = 0; i < due.length; i++) {
      // ruleid: scale-sync-emit-in-loop
      this.eventEmitter.emit('reminder.due', due[i]);
    }
  }

  shareAsBatch(note: any, members: any[]) {
    // ok: scale-sync-emit-in-loop
    this.eventEmitter.emit('note.shared.batch', { noteId: note.id, userIds: members.map((m) => m.id) });
  }

  async shareViaQueue(note: any, members: any[]) {
    for (const member of members) {
      // ok: scale-sync-emit-in-loop
      await this.queue.add('share', { noteId: note.id, userId: member.id });
    }
  }
}
